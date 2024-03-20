import { backtestData } from './backtestdata.js';


backtestData({
    dataFolder: process.env.DATA_FOLDER || '',
    symbol: process.env.SYMBOL || '',
    startTime: new Date(process.env.START_TIME || ''),
    endTime: new Date(),
    callback: ({ time, open, high, low, close, volume }) => {
        console.log(`${time.toISOString()} ${open} ${high} ${low} ${close} ${volume}`);
    }
});