import { createClient, RedisClientType } from 'redis'
import { SoundcloudTrack, SoundcloudStream } from './src/classes/index'
import { AudioPlayer, AudioResource, createAudioPlayer, createAudioResource, NoSubscriberBehavior, AudioPlayerStatus, VoiceConnection, PlayerSubscription, StreamType } from '@discordjs/voice';
import { DiscordUser, QueueTrack } from './src/classes/queue';
import { anonymRequest, ResponseType } from './src/functions/request';
import { PlayerEvent, PlayerEvents } from './src/classes/events';

const SOUNDCLOUD_URL_REGEX: RegExp = /^(https?:\/\/)?(www.)?(m\.)?soundcloud\.com\/[\w\-\.]+(\/)+[\w\-\.]+/;

let redis_cli: RedisClientType | null = null;

interface SearchOptions{
    limit: number,
    genre: string
}
interface RichVoiceConnection extends VoiceConnection{
    subscription: undefined|null|PlayerSubscription
}
export { PlayerEvent as PlayerEvent }
export enum Repeat{
    Off,
    Track,
    Queue
}

interface QueueTrackExt extends QueueTrack{
    active: boolean
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
    public repeat: Repeat;
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
        this.state = PlayerState.Stopped;
        this.repeat = Repeat.Off;
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
            if(this.repeat === Repeat.Track) return this.playAgain()
            return this.playNext()
        })
        this.resource = null;
        redis_cli?.del(`queue:${this.id}`);
    }
    public addListener(event: AudioPlayerStatus, func: () => void):void{
        this.audio_player?.addListener(event, func);
    }
    private async queueLen(): Promise<number>{
        if(!redis_cli) return 0;
        const queue_tracks_raw: string[] = await redis_cli.lRange(`queue:${this.id}`, 0, -1);
        return queue_tracks_raw.length | 0;
    }
    public async queue(): Promise<null|QueueTrackExt[]>{
        if(!redis_cli) return null;
        const queue_tracks_raw: undefined|string[] = await redis_cli.lRange(`queue:${this.id}`, 0, -1);
        if(!queue_tracks_raw) return null;
        const tracks: QueueTrackExt[] = [];
        queue_tracks_raw.forEach((track: string, ind: number) => {
            const queue_track: QueueTrack = JSON.parse(track);
            tracks.push({
                ...queue_track,
                active: this.queue_track === ind
            });
        })   
        return tracks;
    }
    public async isValidTrackId(track_id: number): Promise<null|QueueTrack>{
        if(!redis_cli) return null;
        const queue_track_raw_arr: string[] = await redis_cli.lRange(`queue:${this.id}`, track_id, track_id);
        if(queue_track_raw_arr.length == 0) return null;
        const queue_track: QueueTrack = JSON.parse(queue_track_raw_arr[0]);
        return queue_track;
    }
    public async queueRem(track_id: number): Promise<boolean>{
        if(!redis_cli) return false;
        await redis_cli.lSet(`queue:${this.id}`, track_id, "DELETEDTRACK")
        await redis_cli.lRem(`queue:${this.id}`, 1, "DELETEDTRACK");
        if(track_id <= this.queue_track) this.queue_track--;
        return true;
    }
    public async queueClear(): Promise<boolean>{
        if(!redis_cli) return false;
        const queue_len = await this.queueLen()
        if(queue_len < 1) return false;
        await redis_cli.lTrim(`queue:${this.id}`, queue_len, 0);
        return true;
    }
    private async getQueueTrack(events: boolean = true): Promise<null|QueueTrack>{
        if(!redis_cli) return null;
        const queue_track_raw: string[] = await redis_cli?.lRange(`queue:${this.id}`, this.queue_track, this.queue_track);
        if(queue_track_raw.length == 0 && events){
            // queue has ended
            this.state = PlayerState.Stopped;
            this.audio_player?.stop()
            this.events?.queue_end();
            return null;
        }else if(queue_track_raw.length == 0) return null;
        const queue_track: QueueTrack = JSON.parse(queue_track_raw[0]);
        return queue_track;
    }
    public setRepeat(repeat: Repeat): boolean{
        if(this.repeat == repeat) return false;
        this.repeat = repeat;
        return true;
    }
    public pause(): boolean{
        if(this.state !== PlayerState.Playing) return false;
        if(this.audio_player == null) return false;
        this.audio_player.pause();
        return true;
    }
    public resume(): boolean{
        if(this.state !== PlayerState.Paused) return false;
        if(this.audio_player == null) return false;
        this.audio_player.unpause();
        return true;
    }
    public stop(): boolean{
        if(this.state !== PlayerState.Playing) return false;
        if(this.audio_player == null) return false;
        this.state = PlayerState.Stopped;
        this.audio_player.stop();
        return true;
    }
    public async skip(): Promise<boolean>{
        const queue_len = await this.queueLen()
        if(this.state === PlayerState.Stopped && this.queue_track >= queue_len - 1) return false
        return await this.playNext(true)
    }
    public async play(track: SoundcloudTrack, stream: SoundcloudStream, user: DiscordUser): Promise<boolean>{
        // adding to queue
        const key: string = `queue:${this.id}`;
        const queue_track: null|QueueTrack = new QueueTrack(track, user);
        const track_id: number|undefined = await redis_cli?.rPush(key, JSON.stringify(queue_track));
        // if not playing anything, play added song
        if(this.state != PlayerState.Stopped) return false;
        this.queue_track = (track_id != undefined && track_id > 0) ? (track_id - 1) : 0;
        return this.playStream(stream)
    }
    private playStream(stream: SoundcloudStream){
        if(this.audio_player == null) return false;
        this.resource = null;
        this.resource = createAudioResource(stream.stream, {
            inputType: stream.type,
            //inlineVolume: true
        });
        //this.resource.volume?.setVolume(this.volume);
        this.audio_player.play(this.resource)
        return true
    }
    public async playAgain(): Promise<boolean>{
        const queue_track: null|QueueTrack = await this.getQueueTrack();
        if(!queue_track) return false;
        const soundcloud = new SoundCloud(this.soundcloud_id);
        const fetched_track_array: SoundcloudTrack[]|null = await soundcloud.fetch(queue_track.soundcloud_id);
        if(fetched_track_array == null || fetched_track_array.length == 0) throw new Error('Error while fetching soundcloud track data')
        const stream: SoundcloudStream|null = await soundcloud.stream(fetched_track_array[0]);
        if(stream == null) throw new Error('Error while getting stream from soundcloud track data')
        return this.playStream(stream)
    }
    public async playPrev(): Promise<boolean>{
        this.queue_track--;
        if(this.queue_track < 0) this.queue_track = 0;
        const queue_track: null|QueueTrack = await this.getQueueTrack();
        if(!queue_track) return false;
        const soundcloud = new SoundCloud(this.soundcloud_id);
        const fetched_track_array: SoundcloudTrack[]|null = await soundcloud.fetch(queue_track.soundcloud_id);
        if(fetched_track_array == null || fetched_track_array.length == 0) throw new Error('Error while fetching soundcloud track data')
        const stream: SoundcloudStream|null = await soundcloud.stream(fetched_track_array[0]);
        if(stream == null) throw new Error('Error while getting stream from soundcloud track data')
        if(this.playStream(stream)) {
            this.events?.playing_now(fetched_track_array[0], queue_track.added_by);
            return true;
        }
        return false;
    }
    private async playNext(force: boolean = false): Promise<boolean>{
        if(!force && this.state === PlayerState.Stopped) return false;
        this.queue_track++;
        const queue_track: null|QueueTrack = await this.getQueueTrack(this.repeat !== Repeat.Queue || (this.repeat === Repeat.Queue && this.queue_track === 0));
        if(!queue_track && this.repeat !== Repeat.Queue) return true; // we chekced if it was playing at start so it acutally skipped song
        if(!queue_track){
            this.queue_track = -1;
            return await this.playNext(force)
        }
        const soundcloud = new SoundCloud(this.soundcloud_id);
        const fetched_track_array: SoundcloudTrack[]|null = await soundcloud.fetch(queue_track.soundcloud_id);
        if(fetched_track_array == null || fetched_track_array.length == 0) throw new Error('Error while fetching soundcloud track data')
        const stream: SoundcloudStream|null = await soundcloud.stream(fetched_track_array[0]);
        if(stream == null) throw new Error('Error while getting stream from soundcloud track data')
        if(this.playStream(stream)) {
            this.events?.playing_now(fetched_track_array[0], queue_track.added_by);
            return true;
        }
        return false;
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
        if(query.match(SOUNDCLOUD_URL_REGEX)) return await this.track(query);
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