import AdmZip from 'adm-zip';
import fs from 'fs';

export type BacktestDataCallback = (data: { time: Date, open: number, high: number, low: number, close: number, volume: number }) => void;

export function backtestData({ dataFolder, symbol, startTime, endTime, callback }: { dataFolder: string, symbol: string, startTime: Date, endTime: Date, callback: BacktestDataCallback }) {
    let date = startTime;

    while (date < endTime) {
        let fileName = `${dataFolder}/${symbol}-${date.toISOString().split('T')[0]}.zip`;
        if (!fs.existsSync(fileName)) {
            console.error(`File ${fileName} not found`);
            date.setDate(date.getDate() + 1);
            continue;
        }
        let zipFile = new AdmZip(fileName);
        let zipEntries = zipFile.getEntries();

        for (let i = 0; i < zipEntries.length; i++) {
            let zipEntry = zipEntries[i];
            if (!zipEntry.entryName.endsWith('.csv')) continue;
            let lines = zipEntry.getData().toString().split(/(?:\r\n|\r|\n)/g);
            for (let j = 0; j < lines.length; j++) {
                let line = lines[j];
                if (!line) continue;

                let parts = line.split(',');
                if (parts.length < 6) continue;

                let time = parseInt(parts[0]);
                let open = parseFloat(parts[1]);
                let high = parseFloat(parts[2]);
                let low = parseFloat(parts[3]);
                let close = parseFloat(parts[4]);
                let volume = parseFloat(parts[5]);

                callback({ time: new Date(time), open, high, low, close, volume });
            }
        }

        date.setDate(date.getDate() + 1);
    }
}

export function* optionIndexGenerator({ dataFolder, symbol, startTime, endTime }: { dataFolder: string, symbol: string, startTime: Date, endTime: Date }): Generator<{ time: Date, index: number }> {
    let date = startTime;

    while (date < endTime) {
        let fileName = `${dataFolder}/${symbol}-${date.toISOString().split('T')[0]}.zip`;
        if (!fs.existsSync(fileName)) {
            //console.error(`File ${fileName} not found`);
            date.setDate(date.getDate() + 1);
            continue;
        }
        let zipFile = new AdmZip(fileName);
        let zipEntries = zipFile.getEntries();

        for (let i = 0; i < zipEntries.length; i++) {
            let zipEntry = zipEntries[i];
            if (!zipEntry.entryName.endsWith('.csv')) continue;
            let lines = zipEntry.getData().toString().split(/(?:\r\n|\r|\n)/g);
            for (let j = 1; j < lines.length; j++) {
                let line = lines[j];
                if (!line) continue;

                let parts = line.split(',');
                if (parts.length < 5) continue;

                let timeValue = parseInt(parts[0]);
                let index = parseFloat(parts[4]);
                let time = new Date(timeValue);

                yield ({ time, index });
            }
        }

        date.setDate(date.getDate() + 1);
    }
}