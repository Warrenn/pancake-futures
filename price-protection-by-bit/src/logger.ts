import fs from 'fs/promises';
import { existsSync } from 'fs';

export class Logger {
    static packageData: any | undefined = undefined;
    static previousMessage = '';

    static async logVersion() {
        if (!this.packageData) this.packageData = await this.loadPackageData();
        if (!this.packageData?.version) return;
        await this.log(`version: ${this.packageData.version}`)
    }

    static async loadPackageData(): Promise<any> {
        let packagefile = `${process.env.PACKAGE_CONFIG}`;
        if (!packagefile || !existsSync(packagefile)) return undefined;
        let packagestring = await fs.readFile(packagefile, { encoding: 'utf-8' });
        return JSON.parse(packagestring);
    }

    static async log(message: any): Promise<void> {
        if (!message) return;
        message = `${message}`;


        if (this.previousMessage == message) return;
        this.previousMessage = message;

        console.log(message);
        if (process.env.LOG_FILE) {
            let timestamp = (new Date()).getTime();
            let filetime = timestamp - (timestamp % 86400000);
            let logfilename = process.env.LOG_FILE.replace(/\.log$/g, `.${filetime.toString()}.log`);
            await fs.appendFile(logfilename, `${process.env.LOG_FILE}:${message}\r\n`, { 'encoding': 'utf-8' });
        }
    }
}