import { createClient, RedisClientType } from 'redis'
import { SoundcloudTrack, SoundcloudStream, StreamType } from './src/classes/index'
import { AudioPlayer, AudioResource, createAudioPlayer, createAudioResource, NoSubscriberBehavior, AudioPlayerStatus } from '@discordjs/voice';

let redis_cli: RedisClientType | null = null;

interface SearchOptions{
    limit: number,
    genre: string
}

export class Player{
    public id: string;
    public soundcloud_id: string;
    private connection: any;
    private audio_player: AudioPlayer|null;
    private resource: AudioResource|null;
    private queue: any[];
    private state: AudioPlayerStatus;
    public constructor(player_id: string, soundcloud_id: string, connection: any){
        if(redis_cli == null) throw new Error('Initialize redis first before creating a player');
        this.id = player_id;
        this.soundcloud_id = soundcloud_id;
        this.connection = connection;
        this.state = AudioPlayerStatus.Idle;
        this.audio_player = createAudioPlayer({
            behaviors: {
                noSubscriber: NoSubscriberBehavior.Pause,
            }
        })
        this.connection.subscription = this.connection.subscribe(this.audio_player)
        this.audio_player.addListener(AudioPlayerStatus.Playing, () => {
            this.state = AudioPlayerStatus.Playing;
        })
        this.audio_player.addListener(AudioPlayerStatus.Idle, () => {
            this.state = AudioPlayerStatus.Playing;
            this.queue.shift()
            // remove from queue
            this.playNext()
        })
        this.resource = null;
        this.queue = [];
    }
    public play(track: SoundcloudTrack, stream: SoundcloudStream): void{
        this.queue.push([track, stream]);
        if(this.state == AudioPlayerStatus.Playing) return;
        if(this.audio_player == null) return;
        this.resource = createAudioResource(stream.stream, {
            inputType: stream.type,
            inlineVolume: true
        });
        //this.resource.volume?.setVolume(this.volume);
        this.audio_player.play(this.resource)
    }
    public playNext(){
        console.log('next song')
        if(this.queue.length == 0) return
        const stream: SoundcloudStream = (this.queue[0])[1];
        if(this.audio_player == null) return;
        this.resource = null;
        this.resource = createAudioResource(stream.stream, {
            inputType: stream.type,
            //inlineVolume: true /// premium feature
        });
        this.audio_player.play(this.resource)
    }
    public dispose(): void{
        this.connection.subscription.unsubscribe();
        this.connection.subscription = null;
        this.resource = null;
        this.audio_player?.removeAllListeners(AudioPlayerStatus.Playing)
        this.audio_player?.removeAllListeners(AudioPlayerStatus.Idle)
        this.audio_player?.stop();
        this.audio_player = null;
        return;
    }
}

export class SoundCloud{
    private sc_id: string | null;

    public constructor(soundcloud_id: string){
        this.sc_id = soundcloud_id;
    }
    public async search(query: string, options: SearchOptions|null): Promise<SoundcloudTrack[]|SoundcloudTrack|null>{
        if(this.sc_id == null) return null;
        const url = new URL("https://api-v2.soundcloud.com/search/tracks");
        url.searchParams.set('q', query);
        url.searchParams.set('client_id', this.sc_id);
        url.searchParams.set('limit', String(options?.limit || 5));
        if(options?.genre != null) url.searchParams.set('genre', options.genre);
        const req_options = {
            method: 'GET',
        } as RequestInit;
        const result = await fetch(url, req_options).then(res => res.json()).catch(e => e)
        if(result?.total_results < 1) return null;
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
        const stream_url = await fetch(format_url).then(res => res.json()).catch(e => e);
        if (stream_url instanceof Error || stream_url?.url == null) throw new Error("Failed to get stream: " + stream_url.message);
        return new SoundcloudStream(stream_url.url, chosen.format.mime_type.startsWith('audio/ogg') ? StreamType.OggOpus : StreamType.Arbitrary);
    }
}

export async function getSoundcloudId(): Promise<string|null> {
    const reqoptions = { method: 'GET' } as RequestInit
    const res = await fetch("https://soundcloud.com/", reqoptions).then(r => r.text()).catch(s => s);
    if (res instanceof Error) throw new Error("Failed to get response from soundcloud.com: " + res.message);
    const splitted : string[] = res.split('<script crossorigin src="');
    const links : string[]= [];
    splitted.forEach((s: string) => {
        s.startsWith("https") && links.push(s.split('"')[0]);
    })
    const js_file = await fetch(links[links.length-1], reqoptions).then(r => r.text()).catch(s => s)
    if (res instanceof Error) throw new Error("Failed to get response from soundcloud.com while getting id: " + res.message);
    return js_file.split(',client_id:"')[1].split('"')[0] || null;
}

export async function setupRedisConnection(redis_uri: string){
    redis_cli = createClient({ url: redis_uri });
    redis_cli.on('error', (err: string) => console.error('Redis Client Error:', err));
    await redis_cli.connect()
}