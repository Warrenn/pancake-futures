import AdmZip from 'adm-zip';
import dotenv from 'dotenv';
import fs from 'fs';

dotenv.config({ override: true });

let offset = process.env.OFFSET;
let size = process.env.SIZE;
let dataFolder = process.env.DATA_FOLDER;
let symbol = process.env.SYMBOL;
let startTime = process.env.START_TIME;

let date = new Date(startTime || 0);
let today = new Date();

while (date < today) {
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

            try {
                let timeDate = new Date(time);
                console.log(`${time} ${open} ${high} ${low} ${close} ${volume} ${timeDate.toISOString()}`);
            } catch (e) {
                console.log(e);
            }
        }
    }

    date.setDate(date.getDate() + 1);
}