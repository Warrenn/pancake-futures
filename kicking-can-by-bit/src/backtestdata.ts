import AdmZip from 'adm-zip';
import fs from 'fs';

type backtestDataCallback = (data: { time: Date, open: number, high: number, low: number, close: number, volume: number }) => void;

export function backtestData({ dataFolder, symbol, startTime, endTime, callback }: { dataFolder: string, symbol: string, startTime: Date, endTime: Date, callback: backtestDataCallback }) {
    let date = startTime;

    while (date < endTime) {
        let fileName = `${dataFolder}/${symbol}-${date.toISOString().split('T')[0]}.zip`;
        if (!fs.existsSync(fileName)) {
            console.log(`File ${fileName} not found`);
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