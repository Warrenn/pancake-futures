import fs from 'fs/promises';
import { existsSync } from 'fs';
import { CloudWatchLogsClient, DescribeLogStreamsCommand, CreateLogStreamCommand, PutLogEventsCommand, LogStream } from '@aws-sdk/client-cloudwatch-logs';
export class Logger {
    static loggerFundingRound = 0;
    static logStreamName = '';
    static logGroupName = '';
    static client: CloudWatchLogsClient | undefined = undefined;
    static packageData: any | undefined = undefined;
    static previousMessage = '';

    static async setLoggerFundingRound(fundingRound: number) {
        if (fundingRound == this.loggerFundingRound) return;
        this.loggerFundingRound = fundingRound;

        if (!this.logGroupName) this.logGroupName = `${process.env.LOG_GROUP}`;

        if (this.logGroupName) {
            if (!this.client) this.client = new CloudWatchLogsClient({ region: `${process.env.AWS_REGION}` });
            this.logStreamName = this.stringifyDate(fundingRound).replace(':', '_');
            let stream: LogStream | undefined = undefined
            let logStreams: LogStream[] | undefined = undefined;
            let nextToken: string | undefined = undefined;

            while (true) {
                ({ logStreams, nextToken } = await this.client.send(new DescribeLogStreamsCommand({
                    logGroupName: this.logGroupName,
                    descending: true,
                    nextToken
                })));
                stream = logStreams?.find(s => s.logStreamName == this.logStreamName);
                if (stream) break;
                if (nextToken == undefined) break;
            }
            if (!stream) await this.client.send(new CreateLogStreamCommand({ logGroupName: this.logGroupName, logStreamName: this.logStreamName }));

        }
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

    static stringifyDate(time: number, includeSeconds: boolean = false): string {
        var isoString = (new Date(time)).toISOString();
        return `${isoString.substring(0, 10)}`;
    }

    static async log(message: any): Promise<void> {
        if (!message) return;
        message = `${message}`;
        let timestamp = (new Date()).getTime();
        let messageWithDate = message;
        if (process.env.LOG_DATE) {
            messageWithDate = `${this.stringifyDate(timestamp, true)} ${message}`;
        }
        if (this.previousMessage == message) return;
        this.previousMessage = message;

        console.log(messageWithDate);
        if (process.env.LOG_FOLDER) {
            let filePath = `${process.env.LOG_FOLDER}${this.loggerFundingRound}.log`
            await fs.appendFile(filePath, messageWithDate + "\r", { 'encoding': 'utf-8' });
        }
        if (process.env.NO_AWS_LOGS == 'true') return;
        if (!this.client) this.client = new CloudWatchLogsClient({ region: `${process.env.CCXT_NODE_REGION}` });
        if (!this.logGroupName) this.logGroupName = `${process.env.LOG_GROUP}`;
        if (!this.logStreamName) this.logStreamName = `${this.logStreamName}`;
        if (!this.logStreamName || !this.logGroupName) return;

        message = message.replace("\"", "");
        const command = new PutLogEventsCommand({
            logGroupName: this.logGroupName,
            logStreamName: this.logStreamName,
            logEvents: [{ timestamp, message }]
        });

        await this.client.send(command);
    }
}