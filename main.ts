import { createClient, RedisClientType } from 'redis'
import { SoundcloudTrack, SoundcloudStream } from './src/classes/index'
import { AudioPlayer, AudioResource, createAudioPlayer, createAudioResource, NoSubscriberBehavior, AudioPlayerStatus, VoiceConnection, PlayerSubscription, StreamType } from '@discordjs/voice';
import { DiscordUser, QueueTrack } from './src/classes/queue';
import { anonymRequest, ResponseType } from './src/functions/request';

let redis_cli: RedisClientType | null = null;

interface SearchOptions{
    limit: number,
    genre: string
}
interface RichVoiceConnection extends VoiceConnection{
    subscription: undefined|null|PlayerSubscription
}

export enum PlayerEvent{
    QueueEnd,
    PlayingNow,
    SongEnd,
    BotDisconnect
}

class PlayerEvents{
    // events
    public queue_end: () => void;
    public playing_now: (arg0: SoundcloudTrack, arg1: DiscordUser) => void;
    public song_end: () => void;
    public bot_disc: () => void;
    constructor(){
        this.queue_end = () => {};
        this.playing_now = () => {};
        this.song_end = () => {};
        this.bot_disc = () => {};
    }
    /**
     * Assign function to be triggered on specific event
     * @param event
     * @param func 
     * @returns void
     */
    assign(event: PlayerEvent, func: () => void){
        if(event == PlayerEvent.QueueEnd){
            this.queue_end = func;
            return;
        }
        if(event == PlayerEvent.PlayingNow){
            this.playing_now = func;
            return;
        }
        if(event == PlayerEvent.SongEnd){
            this.song_end = func;
            return;
        }
        if(event == PlayerEvent.BotDisconnect){
            this.bot_disc = func;
            return;
        }
        throw new Error('Invalid event is provided in PlayerEvents')
    }
    remove(event: PlayerEvent){
        if(event == PlayerEvent.QueueEnd){
            this.queue_end = () => {};
            return;
        }
        if(event == PlayerEvent.PlayingNow){
            this.playing_now = () => {};
            return;
        }
        if(event == PlayerEvent.SongEnd){
            this.song_end = () => {};
            return;
        }
        if(event == PlayerEvent.BotDisconnect){
            this.bot_disc = () => {};
            return;
        }
        throw new Error('Invalid event is provided in PlayerEvents')
    }
    dispose(){
        this.queue_end = () => {};
        this.playing_now = () => {};
        this.song_end = () => {};
        this.bot_disc = () => {};
    }
}

enum PlayerState{
    Playing,
    Paused,
    Idle,
    Stopped
}

export class Player{
    public id: string;
    public soundcloud_id: string;
    public queue_track: number;
    private connection: RichVoiceConnection;
    private audio_player: AudioPlayer|null;
    private resource: AudioResource|null;
    private state: PlayerState;
    private disconnect_timeout: null|NodeJS.Timeout;
    public events: null|PlayerEvents;
    /**
     * @param player_id Specify unique id for player. If there is one player per guild it is recommended to be guild id
     * @param soundcloud_id Sound cloud client id. It can be obtain with getSoundCloudId()
     * @param connection Bot voice connection object
     */
    public constructor(player_id: string, soundcloud_id: string, connection: RichVoiceConnection){
        if(redis_cli == null) throw new Error('Initialize redis first before creating a player');
        this.id = player_id;
        this.soundcloud_id = soundcloud_id;
        this.connection = connection;
        this.queue_track = -1;
        this.disconnect_timeout = null;
        this.events = new PlayerEvents();
        this.state = PlayerState.Idle;
        this.audio_player = createAudioPlayer({
            behaviors: {
                noSubscriber: NoSubscriberBehavior.Pause,
            }
        })
        this.connection.subscription = this.connection.subscribe(this.audio_player)
        this.audio_player.addListener(AudioPlayerStatus.Playing, () => {
            this.state = PlayerState.Playing;
            if(this.disconnect_timeout != null) clearTimeout(this.disconnect_timeout);
        })
        this.audio_player.addListener(AudioPlayerStatus.Paused, () => {
            this.state = PlayerState.Paused;
            //if(this.disconnect_timeout != null) clearTimeout(this.disconnect_timeout);
        })
        this.audio_player.addListener(AudioPlayerStatus.Idle, () => {
            // auto disconnect
            this.disconnect_timeout = setTimeout(() => {
                this.events?.bot_disc()
                this.connection.disconnect()
            }, 60_000 * 3) // 3 minutes
            // trigger event
            this.events?.song_end()
            if(this.state == PlayerState.Stopped) return;
            this.state = PlayerState.Idle;
            this.playNext()
        })
        this.resource = null;
    }
    public addListener(event: AudioPlayerStatus, func: () => void):void{
        this.audio_player?.addListener(event, func);
    }
    public async play(track: SoundcloudTrack, stream: SoundcloudStream, user: DiscordUser): Promise<boolean>{
        // adding to queue
        const key = `queue:${this.id}`;
        const queue_track: QueueTrack = new QueueTrack(track, user);
        const track_id: number|undefined = await redis_cli?.rPush(key, JSON.stringify(queue_track));
        // if not playing anything, play added song
        if(this.state == PlayerState.Playing || this.state == PlayerState.Paused) return false;
        if(this.audio_player == null) return false;
        this.queue_track = (track_id != undefined && track_id > 0) ? (track_id - 1) : 0;
        this.resource = createAudioResource(stream.stream, {
            inputType: stream.type,
            //inlineVolume: true
        });
        //this.resource.volume?.setVolume(this.volume);
        this.audio_player.play(this.resource)
        return true
    }
    public async playNext(): Promise<boolean>{
        if(this.state == PlayerState.Stopped) return false;
        this.queue_track++;
        const queue_track_raw: undefined|string[] = await redis_cli?.lRange(`queue:${this.id}`, this.queue_track, this.queue_track);
        if(queue_track_raw == undefined || queue_track_raw.length == 0){
            // queue has ended
            this.queue_track--;
            this.state = PlayerState.Stopped;
            this.audio_player?.stop()
            this.events?.queue_end()
            return false;
        }
        const queue_track: QueueTrack = JSON.parse(queue_track_raw[0]);
        const soundcloud = new SoundCloud(this.soundcloud_id);
        const fetched_track_array: SoundcloudTrack[]|null = await soundcloud.fetch(queue_track.soundcloud_id);
        if(fetched_track_array == null || fetched_track_array.length == 0) throw new Error('Error while fetching soundcloud track data')
        const stream: SoundcloudStream|null = await soundcloud.stream(fetched_track_array[0]);
        if(stream == null) throw new Error('Error while getting stream from soundcloud track data')
        this.resource = null;
        this.resource = createAudioResource(stream.stream, {
            inputType: stream.type,
            //inlineVolume: true /// premium feature
        });
        this.audio_player?.play(this.resource)
        this.events?.playing_now(fetched_track_array[0], queue_track.added_by);
        return true;
    }
    public dispose(): void{
        this.connection.subscription?.unsubscribe();
        this.connection.subscription = null;
        this.resource = null;
        this.audio_player?.removeAllListeners(AudioPlayerStatus.Playing)
        this.audio_player?.removeAllListeners(AudioPlayerStatus.Idle)
        this.audio_player?.removeAllListeners(AudioPlayerStatus.Paused)
        this.audio_player?.removeAllListeners(AudioPlayerStatus.Buffering)
        this.audio_player?.removeAllListeners(AudioPlayerStatus.AutoPaused)
        this.audio_player?.stop();
        this.audio_player = null;
        this.events?.dispose();
        this.events = null;
        redis_cli?.del(`queue:${this.id}`);
        return;
    }
}

export class SoundCloud{
    private sc_id: string | null;

    /**
     * Initialize class for further manipulation of soundcloud data
     * @param soundcloud_id Soundcloud user id
     */
    public constructor(soundcloud_id: string){
        this.sc_id = soundcloud_id;
    }
    /**
     * From sent array of ids returns fetched soundcloud object tracks
     * @param ids Array of soundcloud track ids
     * @returns Fetched SoundcloudTrack object
     */
    public async fetch(...ids: number[]): Promise<SoundcloudTrack[]|null>{
        if(this.sc_id == null) return null;
        const url = new URL("https://api-v2.soundcloud.com/tracks");
        const ids_string: string = ids.join('%');
        url.searchParams.set('ids', ids_string);
        url.searchParams.set('client_id', this.sc_id);
        const result = await anonymRequest(url, { method: 'GET' }, ResponseType.JSON);
        if(result instanceof Error || result?.length == 0) return null;
        const tracks: SoundcloudTrack[] = [];
        result?.forEach((track:any) => {
            const sc_track: SoundcloudTrack = new SoundcloudTrack(track);
            tracks.push(sc_track);
        })
        return tracks;
    }
    /**
     * Returns fetched soundcloud track object from given URL
     * @param track_url URL of soundcloud track (E.g. "https://soundcloud.com/we-us/jennifer-lopez-feat-pitbull-on")
     * @returns Fetched SoundcloudTrack object
    **/
    public async track(track_url: string): Promise<null|SoundcloudTrack>{
        if(this.sc_id == null) return null;
        const url = new URL('https://api-v2.soundcloud.com/resolve')
        url.searchParams.set('url', track_url);
        url.searchParams.set('client_id', this.sc_id);
        const response = await anonymRequest(url, { method: 'GET' }, ResponseType.JSON);
        if(response instanceof Error) return null;
        return new SoundcloudTrack(response);
    }
    /**
     * 
     * @param query Search query: keywords, name, or author of the track
     * @param options Optionally provide additional informations. limit -> Number of results (If limit is set to 1, function will return object instead of array). genre -> Genre of tracks for more precise search. 
     * @returns Array of SoundcloudTrack objects or SoundcloudTrack object if limit is set to 1
     */
    public async search(query: string, options: SearchOptions|null): Promise<SoundcloudTrack[]|SoundcloudTrack|null>{
        if(this.sc_id == null) return null;
        const url = new URL("https://api-v2.soundcloud.com/search/tracks");
        url.searchParams.set('q', query);
        url.searchParams.set('client_id', this.sc_id);
        url.searchParams.set('limit', String(options?.limit || 5));
        if(options?.genre != null) url.searchParams.set('genre', options.genre);
        const result = await anonymRequest(url, { method: 'GET' }, ResponseType.JSON);
        if(result instanceof Error || result?.total_results < 1) return null;
        const tracks: SoundcloudTrack[] = [];
        // if only 1 track is requested
        if(options?.limit === 1) return new SoundcloudTrack(result?.collection[0]);
        // else if more that 1
        result?.collection?.forEach((track:any) => {
            const sc_track: SoundcloudTrack = new SoundcloudTrack(track);
            tracks.push(sc_track);
        })
        return tracks;
    }
    /**
     * For passed track function will return stream data and stream type
     * @param track Fetched SoundcloudTrack object
     * @returns SoundcloudStream object
     */
    public async stream(track: SoundcloudTrack): Promise<SoundcloudStream|null>{
        const hls_formats: any[] = []
        track.formats.forEach((format: any) => {
            const protocol: string = format?.format?.protocol;
            if(protocol == 'hls') hls_formats.push(format);
        })
        if(hls_formats.length === 0) return null;
        const chosen: any = hls_formats[hls_formats.length - 1];
        const format_url = new URL(chosen.url)
        format_url.searchParams.set('client_id', String(this.sc_id));
        const stream_url = await anonymRequest(format_url, { method: 'GET' }, ResponseType.JSON);
        if (stream_url instanceof Error || stream_url?.url == null) throw new Error("Failed to get stream: " + stream_url.message);
        return new SoundcloudStream(stream_url.url, chosen.format.mime_type.startsWith('audio/ogg') ? StreamType.OggOpus : StreamType.Arbitrary);
    }
}

/**
 * A bit of hacking to retrieve generated client id from soundcloud
 * @returns Soundcloud client id
 */
export async function getSoundcloudId(): Promise<string|null> {
    const res = await anonymRequest('https://soundcloud.com', { method: 'GET', headers: {} }, ResponseType.Text);
    if (res instanceof Error) throw new Error("Failed to get response from soundcloud.com: " + res.message);
    const splitted : string[] = res.split('<script crossorigin src="');
    const links : string[]= [];
    splitted.forEach((s: string) => {
        s.startsWith("https") && links.push(s.split('"')[0]);
    })
    const js_file = await fetch(links[links.length-1]).then(res => res.text()).catch(err => err)
    if (js_file instanceof Error) throw new Error("Failed to get response from soundcloud.com while getting id: " + res.message);
    return js_file.split(',client_id:"')[1].split('"')[0] || null;
}

export async function setupRedisConnection(redis_uri: string){
    redis_cli = createClient({ url: redis_uri });
    redis_cli.on('error', (err: string) => console.error('Redis Client Error:', err));
    await redis_cli.connect()
}