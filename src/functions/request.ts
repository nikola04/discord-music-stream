import userAgents from '../useragents.json'
export enum ResponseType{
    JSON,
    Text
}

import fs from 'fs';
const log_file = fs.createWriteStream('requests.log');

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
        const response: Response = await fetch(url, options).catch(er => {
            log_file.write(JSON.stringify(er))
            return er;
        });
        if (!response.ok) {
            log_file.write(`${response.status} ${response.statusText}\n`)
            return new Error(`${response.status} ${response.statusText}`);
        }
        if(response_type == ResponseType.JSON) return await response.json()
        if(response_type == ResponseType.Text) return await response.text()
        return response;
    }catch(err){
        console.log('Request Error: ', err)
        return err;
    }
}