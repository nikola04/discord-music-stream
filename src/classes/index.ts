import { Readable } from 'node:stream'
import { IncomingMessage } from 'node:http';
import { request_stream } from '../Request';
import { StreamType } from '@discordjs/voice';

export class SoundcloudTrack {
    id: number;
    title: string;
    url: string;
    thumbnail_url: string;
    duration: number;
    formats: any[];
    type: 'track' | 'playlist'

    constructor(data: any){
        this.id = data.id;
        this.title = data.title;
        this.url = data.permalink_url;
        this.thumbnail_url = data.artwork_url;
        this.duration = data.duration;
        this.type = 'track';
        this.formats = data.media.transcodings
    }
}

// cheated for this... :(
export class SoundcloudStream {
    stream: Readable;
    type: StreamType;
    private url: string;
    private downloaded_time: number;
    private timer: Timer;
    private downloaded_segments: number;
    private request: IncomingMessage | null;
    private time: number[];
    private segment_urls: string[];

    constructor(url: string, type: StreamType = StreamType.Arbitrary) {
        this.stream = new Readable({ highWaterMark: 5 * 1000 * 1000, read() {} });
        this.type = type;
        this.url = url;
        this.downloaded_time = 0;
        this.request = null;
        this.downloaded_segments = 0;
        this.time = [];
        this.timer = new Timer(() => {
            this.timer.reuse();
            this.start();
        }, 280);
        this.segment_urls = [];
        this.stream.on('close', () => {
            this.cleanup();
        });
        this.start();
    }
    /**
     * Parses SoundCloud dash file.
     * @private
     */
    private async parser() {
        const response = await fetch(this.url, { method: "GET" }).then(data => data.text()).catch((err: Error) => {
            return err;
        });
        if (response instanceof Error) throw response;
        const array = response?.split('\n');
        array.forEach((val:any) => {
            if (val.startsWith('#EXTINF:')) {
                this.time.push(parseFloat(val.replace('#EXTINF:', '')));
            } else if (val.startsWith('https')) {
                this.segment_urls.push(val);
            }
        });
        return;
    }
    /**
     * Starts looping of code for getting all segments urls data
     */
    private async start() {
        if (this.stream.destroyed) {
            this.cleanup();
            return;
        }
        this.time = [];
        this.segment_urls = [];
        this.downloaded_time = 0;
        await this.parser();
        this.segment_urls.splice(0, this.downloaded_segments);
        this.loop();
    }
    /**
     * Main Loop function for getting all segments urls data
     */
    private async loop() {
        if (this.stream.destroyed) {
            this.cleanup();
            return;
        }
        if (this.time.length === 0 || this.segment_urls.length === 0) {
            this.cleanup();
            this.stream.push(null);
            return;
        }
        this.downloaded_time += this.time.shift() as number;
        this.downloaded_segments++;
        const stream = await request_stream(this.segment_urls.shift() as string).catch((err: Error) => err);
        if (stream instanceof Error) {
            this.stream.emit('error', stream);
            this.cleanup();
            return;
        }

        this.request = stream;
        stream.on('data', (c:any) => {
            this.stream.push(c);
        });
        stream.on('end', () => {
            if (this.downloaded_time >= 300) return;
            else this.loop();
        });
        stream.once('error', (err:string) => {
            this.stream.emit('error', err);
        });
    }
    private cleanup() {
        this.timer.destroy();
        this.request?.destroy();
        this.url = '';
        this.downloaded_time = 0;
        this.downloaded_segments = 0;
        this.request = null;
        this.time = [];
        this.segment_urls = [];
    }
    pause() {
        this.timer.pause();
    }
    resume() {
        this.timer.resume();
    }
}


export class Timer {
    /**
     * Boolean for checking if Timer is destroyed or not.
     */
    private destroyed: boolean;
    /**
     * Boolean for checking if Timer is paused or not.
     */
    private paused: boolean;
    /**
     * setTimeout function
     */
    private timer: any;
    /**
     * Callback to be executed once timer finishes.
     */
    private callback: () => void;
    /**
     * Seconds time when it is started.
     */
    private time_start: number;
    /**
     * Total time left.
     */
    private time_left: number;
    /**
     * Total time given by user [ Used only for re-using timer. ]
     */
    private time_total: number;
    /**
     * Constructor for Timer Class
     * @param callback Function to execute when timer is up.
     * @param time Total time to wait before execution.
     */
    constructor(callback: () => void, time: number) {
        this.callback = callback;
        this.time_total = time;
        this.time_left = time;
        this.paused = false;
        this.destroyed = false;
        this.time_start = process.hrtime()[0];
        this.timer = setTimeout(this.callback, this.time_total * 1000);
    }
    /**
     * Pauses Timer
     * @returns Boolean to tell that if it is paused or not.
     */
    pause() {
        if (!this.paused && !this.destroyed) {
            this.paused = true;
            clearTimeout(this.timer);
            this.time_left = this.time_left - (process.hrtime()[0] - this.time_start);
            return true;
        } else return false;
    }
    /**
     * Resumes Timer
     * @returns Boolean to tell that if it is resumed or not.
     */
    resume() {
        if (this.paused && !this.destroyed) {
            this.paused = false;
            this.time_start = process.hrtime()[0];
            this.timer = setTimeout(this.callback, this.time_left * 1000);
            return true;
        } else return false;
    }
    /**
     * Reusing of timer
     * @returns Boolean to tell if it is re-used or not.
     */
    reuse() {
        if (!this.destroyed) {
            clearTimeout(this.timer);
            this.time_left = this.time_total;
            this.paused = false;
            this.time_start = process.hrtime()[0];
            this.timer = setTimeout(this.callback, this.time_total * 1000);
            return true;
        } else return false;
    }
    /**
     * Destroy timer.
     *
     * It can't be used again.
     */
    destroy() {
        clearTimeout(this.timer);
        this.destroyed = true;
        this.callback = () => {};
        this.time_total = 0;
        this.time_left = 0;
        this.paused = false;
        this.time_start = 0;
    }
}