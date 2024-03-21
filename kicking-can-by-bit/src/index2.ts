import { backtestData, BacktestDataCallback } from './backtestdata.js';
import dotenv from 'dotenv';

let totalLoss = 0;
let offset = 2;
let stepSize = 25;
let days = 0;
let largestLoss = 0;
let totalGain = 0;
let totalPositionGain = 0;
let fakeTradeTotal = 0;
let dailyGain = 70;//14;//
let bounceMax = 2;

function createCallback(): BacktestDataCallback {
    let timeText = '';
    let dateOpen = 0;
    let dateClose = 0;
    let dateHigh = 0;
    let dateLow = 0;
    let upper = 0;
    let lower = 0;

    let upperBounceCount = 0;
    let lowerBounceCount = 0;

    let longPosition = 0;
    let shortPosition = 0;

    let offsetSize = offset * stepSize;

    return ({ time, open, high, low, close }) => {
        if (!timeText) {
            timeText = time.toISOString().split('T')[0];
            dateOpen = open;
            dateClose = close;
            dateHigh = high;
            dateLow = low;
        }
        if (high > dateHigh) dateHigh = high;
        if (low < dateLow) dateLow = low;
        dateClose = close;

        if (upper > 0 && high > upper && upperBounceCount < bounceMax) {
            upperBounceCount++;
            upper = upper + offsetSize;
        }

        if (lower > 0 && low < lower && lowerBounceCount < bounceMax) {
            lowerBounceCount++;
            lower = lower - offsetSize;
        }

        // if (upperBounceCount === bounceMax && shortPosition === 0 && longPosition === 0) longPosition = high;
        // if (lowerBounceCount === bounceMax && shortPosition === 0 && longPosition === 0) shortPosition = low;

        if (time.getUTCHours() === 5 && time.getUTCMinutes() >= 0 && lower === 0 && upper === 0) {
            let midPoint = Math.round(open / stepSize) * stepSize;
            // if (midPoint > open) upper = midPoint + offsetSize;
            // if (midPoint < open) lower = midPoint - offsetSize;

            // lower = midPoint - offsetSize;
            // upper = midPoint + offsetSize;
        }

        let nextTimeText = time.toISOString().split('T')[0];
        if (time.getUTCHours() === 8 && nextTimeText !== timeText) {
            let loss = 0;
            let positionGain = 0;
            let fakeTrade = 0;
            if (upper > 0 && close > upper && longPosition === 0) loss = close - upper;
            if (lower > 0 && close < lower && shortPosition === 0) loss = lower - close;
            if (longPosition > 0 && close < longPosition) fakeTrade = longPosition - close;
            if (shortPosition > 0 && close > shortPosition) fakeTrade = close - shortPosition;

            if (longPosition > 0 && upper > 0 && upper > longPosition && close > longPosition)
                positionGain = upper - longPosition;
            if (shortPosition > 0 && lower > 0 && lower < shortPosition && close < shortPosition)
                positionGain = shortPosition - lower;

            if (loss > largestLoss) largestLoss = (loss + fakeTrade);
            totalGain += (dailyGain - loss - fakeTrade + positionGain);
            totalPositionGain += positionGain;
            fakeTradeTotal += fakeTrade;

            totalLoss += (loss + fakeTrade);
            days++;

            console.log(`${timeText},${Math.round(loss)}`);
            timeText = nextTimeText;
            dateOpen = open;
            dateClose = close;
            dateHigh = high;
            dateLow = low;
            longPosition = 0;
            shortPosition = 0;

            lowerBounceCount = 0;
            upperBounceCount = 0;
            lower = 0;
            upper = 0;
            let midPoint = Math.round(open / stepSize) * stepSize;
            lower = midPoint - offsetSize;
            upper = midPoint + offsetSize;
        }
    };

}

dotenv.config({ override: true });
let callback = createCallback();
backtestData({
    dataFolder: process.env.DATA_FOLDER || '',
    symbol: process.env.SYMBOL || '',
    startTime: new Date('2021-01-01'),
    endTime: new Date('2024-03-20'),
    callback,
});
console.log(`Bidgest totalloss:${totalLoss} ${totalLoss / days} largest loss: ${largestLoss} days: ${days} total position gain: ${totalPositionGain} net gain: ${totalGain} average gain: ${totalGain / days}`);
console.log('Done');