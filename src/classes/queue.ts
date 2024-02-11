import { StreamType } from "@discordjs/voice";
import { SoundcloudTrack } from ".";

export interface DiscordUser{
    id: number,
    nickname: string
}

export class QueueTrack{
    soundcloud_id: number;
    added_by: DiscordUser;
    title: string;
    url: string;
    duration: number;
    thumbnail_url: string;

    constructor(track: SoundcloudTrack, user: DiscordUser){
        this.soundcloud_id = track.id;
        this.title = track.title;
        this.url = track.url;
        this.duration = track.duration;
        this.thumbnail_url = track.thumbnail_url;
        this.added_by = user;
    }
}