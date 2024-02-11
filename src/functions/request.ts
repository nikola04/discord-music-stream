import userAgents from '../useragents.json'
export enum ResponseType{
    JSON,
    Text
}

import fs from 'fs';

/**
 * Fetch function in base and additionally added random user agents
 * @param url API Endpoint
 * @param options HTTPS Request options object. Parameters: headers, body...
 * @param response_type Optional - JSON or Text as response data. Text is default, null for raw response
 * @returns Response or null in case of error
 */

interface UserAgent{
    device: string,
    useragent: string
}
export async function anonymRequest(url: URL|string, options: RequestInit, response_type: ResponseType|null = ResponseType.Text){
    try{
        const response: Response = await fetch(url, options).catch(er => er);
        if(!response.ok) {
            console.log(response, response.status)
        }
        if (!response.ok) return new Error(`${response.status} ${response.statusText}`);
        if(response_type == ResponseType.JSON) return await response.json()
        if(response_type == ResponseType.Text) return await response.text()
        return response;
    }catch(err){
        console.log('Request Error: ', err)
        return err;
    }
}