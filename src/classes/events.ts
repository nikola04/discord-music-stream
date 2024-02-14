export enum PlayerEvent{
    QueueEnd,
    PlayingNow,
    SongEnd,
    BotDisconnect
}

export class PlayerEvents{
    // events
    public queue_end: (...arg: any) => void;
    public playing_now: (...arg: any) => void;
    public song_end: (...arg: any) => void;
    public bot_disc: (...arg: any) => void;
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