import { backtestData, BacktestDataCallback, optionIndexGenerator } from './backtestdata.js';
import dotenv from 'dotenv';

const msDay = 1000 * 60 * 60 * 24;

let days = 0;
let totalGain = 0;
let daysWithGain = 0;
let largestLoss = 0;

const target = 160;//14;//
const defaultSigma = 0.86;
const bounceMax = 3;
const initialOffset = 4;
const shiftSize = 2;
const stepSize = 25;

// Function to calculate the cumulative distribution function of the standard normal distribution
function cumulativeDistribution(x: number) {
    const a1 = 0.31938153;
    const a2 = -0.356563782;
    const a3 = 1.781477937;
    const a4 = -1.821255978;
    const a5 = 1.330274429;
    const gamma = 0.2316419;

    const t = 1 / (1 + gamma * Math.abs(x));
    const z = Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI);
    const n = 1 - z * (a1 * t + a2 * Math.pow(t, 2) + a3 * Math.pow(t, 3) + a4 * Math.pow(t, 4) + a5 * Math.pow(t, 5));

    if (x >= 0) {
        return n;
    } else {
        return 1 - n;
    }
}

// Function to calculate the theoretical price of a call option
function callOptionPrice(currentPrice: number, strikePrice: number, r: number, timeToExpiration: number, sigma: number) {
    const d1 = (Math.log(currentPrice / strikePrice) + (r + (Math.pow(sigma, 2) / 2)) * timeToExpiration) / (sigma * Math.sqrt(timeToExpiration));
    const d2 = d1 - sigma * Math.sqrt(timeToExpiration);
    const N_d1 = cumulativeDistribution(d1);
    const N_d2 = cumulativeDistribution(d2);
    return currentPrice * N_d1 - strikePrice * Math.exp(-r * timeToExpiration) * N_d2;
}

// Function to calculate the theoretical price of a put option
function putOptionPrice(currentPrice: number, strikePrice: number, r: number, timeToExpiration: number, sigma: number) {
    const d1 = (Math.log(currentPrice / strikePrice) + (r + (Math.pow(sigma, 2) / 2)) * timeToExpiration) / (sigma * Math.sqrt(timeToExpiration));
    const d2 = d1 - sigma * Math.sqrt(timeToExpiration);
    const N_minus_d1 = cumulativeDistribution(-d1);
    const N_minus_d2 = cumulativeDistribution(-d2);
    return strikePrice * Math.exp(-r * timeToExpiration) * N_minus_d2 - currentPrice * N_minus_d1;
}

function calculateTimeToExpiration({
    current,
    expiration
}: { current: Date, expiration: Date }): number {
    let diff = expiration.getTime() - current.getTime();
    return 1 / 365 * (diff / msDay);
}

function getSigmaAtDate({ iterator, date, defaultValue }: { iterator: Generator<{ time: Date, index: number }>, date: Date, defaultValue: number }): number {
    while (true) {
        let result = iterator.next();
        if (result.done) return defaultValue;
        let { time, index } = result.value;
        if (time.getUTCFullYear() === date.getUTCFullYear() &&
            time.getUTCMonth() === date.getUTCMonth() &&
            time.getUTCDate() === date.getUTCDate() &&
            time.getUTCHours() === date.getUTCHours() &&
            time.getUTCMinutes() === date.getUTCMinutes()) return index / 100;
        if (time.getTime() > date.getTime()) return defaultValue;
    }
}

function createCallback(iterator: Generator<{ time: Date, index: number }>): BacktestDataCallback {
    let callStrike = 0;
    let putStrike = 0;

    let callBounceCount = 0;
    let putBounceCount = 0;

    let callBalance = 0;
    let putBalance = 0;

    let callSize = 0;
    let putSize = 0;
    let expiration: Date | undefined = undefined;

    let offsetSize = shiftSize * stepSize;
    let initialSize = initialOffset * stepSize;
    let optionTarget = target / 2;

    return ({ time, open, high, low, close }) => {
        if (expiration === undefined) {
            let timeText = time.toISOString().split('T')[0];
            expiration = (new Date(`${timeText}T08:00:00.0000Z`));
            expiration.setDate(expiration.getDate() + 1);
        }

        if (callStrike === 0 && callBounceCount < bounceMax) {
            let strikePrice = Math.round(open / stepSize) * stepSize;
            callStrike = strikePrice + (callBounceCount === 0 ? initialSize : offsetSize);
            callBounceCount++;

            let timeToExpiration = calculateTimeToExpiration({ current: time, expiration });
            let sigma = getSigmaAtDate({ iterator, date: time, defaultValue: defaultSigma });
            let callPrice = callOptionPrice(open, callStrike, 0, timeToExpiration, sigma);

            callSize = optionTarget / callPrice;
            callBalance = callBalance + (callSize * callPrice);
        }

        if (putStrike === 0 && putBounceCount < bounceMax) {
            let strikePrice = Math.round(open / stepSize) * stepSize;
            putStrike = strikePrice - (putBounceCount === 0 ? initialSize : offsetSize);
            putBounceCount++;

            let timeToExpiration = calculateTimeToExpiration({ current: time, expiration });
            let sigma = getSigmaAtDate({ iterator, date: time, defaultValue: defaultSigma });
            let putPrice = putOptionPrice(open, putStrike, 0, timeToExpiration, sigma);

            putSize = optionTarget / putPrice;
            putBalance = putBalance + (putSize * putPrice);
        }

        if (callStrike > 0 && high > callStrike) {
            let timeToExpiration = calculateTimeToExpiration({ current: time, expiration });
            let sigma = getSigmaAtDate({ iterator, date: time, defaultValue: defaultSigma });
            let callPrice = callOptionPrice(open, callStrike, 0, timeToExpiration, sigma);
            callBalance = callBalance - (callSize * callPrice);
            callStrike = 0;
        }

        if (putStrike > 0 && low < putStrike) {
            let timeToExpiration = calculateTimeToExpiration({ current: time, expiration });
            let sigma = getSigmaAtDate({ iterator, date: time, defaultValue: defaultSigma });
            let putPrice = putOptionPrice(open, putStrike, 0, timeToExpiration, sigma);
            putBalance = putBalance - (putSize * putPrice);
            putStrike = 0;
        }

        if (time.getTime() === expiration.getTime()) {
            let positionGain = callBalance + putBalance;

            if (positionGain > 0) daysWithGain++;
            if (positionGain < -largestLoss) largestLoss = -positionGain;

            totalGain += positionGain;
            days++;

            let timeText = time.toISOString().split('T')[0];
            console.log(`${timeText},${callStrike},${putStrike},${positionGain}`);

            callStrike = 0;
            putStrike = 0;

            callBounceCount = 0;
            putBounceCount = 0;

            callBalance = 0;
            putBalance = 0;

            callSize = 0;
            putSize = 0;

            expiration = (new Date(`${timeText}T08:00:00.0000Z`));
            expiration.setDate(expiration.getDate() + 1);
        }
    };
}

dotenv.config({ override: true });

let iterator = optionIndexGenerator({
    dataFolder: `${process.env.DATA_FOLDER}/${process.env.BVOL_SYMBOL}/`,
    symbol: process.env.BVOL_SYMBOL || '',
    startTime: new Date(process.env.START_TIME || ''),
    endTime: new Date()
});
backtestData({
    dataFolder: `${process.env.DATA_FOLDER}/${process.env.SYMBOL}/`,
    symbol: process.env.SYMBOL || '',
    startTime: new Date(process.env.START_TIME || ''),
    endTime: new Date(),
    callback: createCallback(iterator)
});

console.log(`Bidgest days: ${days} days with gain: ${daysWithGain} gain pct: ${Math.round(daysWithGain / days * 100)}% net gain: ${totalGain} average gain: ${totalGain / days} largest loss: ${largestLoss}`);
console.log(`DONE`);
// console.log('Done');