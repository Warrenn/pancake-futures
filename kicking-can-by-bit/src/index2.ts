import { backtestData, BacktestDataCallback, optionIndexGenerator } from './backtestdata.js';
import dotenv from 'dotenv';

const msDay = 1000 * 60 * 60 * 24;

let days = 0;
let totalGain = 0;
let totalLoss = 0;
let optionPutDays = 0;
let optionCallDays = 0;
let daysWithGain = 0;
let daysWithNothing = 0;
let largestLoss = 0;
let totalPutSize = 0;
let totalCallSize = 0;

const target = 320;//14;//
const maxOptionSize = 14;//40;
const defaultSigma = 0.86;
const initialOffset = 1;
const shiftSize = 1;
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

        if (callStrike === 0) {
            let strikePrice = Math.round(open / stepSize) * stepSize;
            callStrike = strikePrice + ((callBalance === 0) ? initialSize : offsetSize);

            let timeToExpiration = calculateTimeToExpiration({ current: time, expiration });
            let sigma = getSigmaAtDate({ iterator, date: time, defaultValue: defaultSigma });
            let callPrice = callOptionPrice(open, callStrike, 0, timeToExpiration, sigma);
            if (isNaN(callPrice) || callPrice <= 0) {
                callStrike = 0;
            }
            else {
                let callTarget = optionTarget - callBalance;

                callSize = callTarget / callPrice;
                if (callSize > maxOptionSize) {
                    callStrike = 0;
                    callSize = 0;
                } else {
                    callBalance = callBalance + (callSize * callPrice);
                }
            }
        }

        if (putStrike === 0) {
            let strikePrice = Math.round(open / stepSize) * stepSize;
            putStrike = strikePrice - ((putBalance === 0) ? initialSize : offsetSize);

            let timeToExpiration = calculateTimeToExpiration({ current: time, expiration });
            let sigma = getSigmaAtDate({ iterator, date: time, defaultValue: defaultSigma });
            let putPrice = putOptionPrice(open, putStrike, 0, timeToExpiration, sigma);
            if (isNaN(putPrice) || putPrice <= 0) {
                putStrike = 0;
            } else {
                let putTarget = optionTarget - putBalance;

                putSize = putTarget / putPrice;
                if (putSize > maxOptionSize) {
                    putStrike = 0;
                    putSize = 0;
                } else {
                    putBalance = putBalance + (putSize * putPrice);
                }
            }
        }

        if (callStrike > 0 && high > callStrike) {
            let timeToExpiration = calculateTimeToExpiration({ current: time, expiration });
            let sigma = getSigmaAtDate({ iterator, date: time, defaultValue: defaultSigma });
            let callPrice = callOptionPrice(open, callStrike, 0, timeToExpiration, sigma);
            if (!isNaN(callPrice) && callBalance > 0) {
                callBalance = callBalance - (callSize * callPrice);
                callStrike = 0;
            }
        }

        if (putStrike > 0 && low < putStrike) {
            let timeToExpiration = calculateTimeToExpiration({ current: time, expiration });
            let sigma = getSigmaAtDate({ iterator, date: time, defaultValue: defaultSigma });
            let putPrice = putOptionPrice(open, putStrike, 0, timeToExpiration, sigma);
            if (!isNaN(putPrice) && putPrice > 0) {
                putBalance = putBalance - (putSize * putPrice);
                putStrike = 0;
            }
        }

        if (time.getTime() >= expiration.getTime()) {
            let positionGain = callBalance + putBalance;

            if (positionGain === 0) daysWithNothing++;
            if (positionGain > 0) daysWithGain++;
            if (positionGain < 0) totalLoss += -positionGain;
            if (positionGain < -largestLoss) largestLoss = -positionGain;
            if (putSize > 0) optionPutDays++;
            if (callSize > 0) optionCallDays++;

            totalPutSize += putSize;
            totalCallSize += callSize;

            totalGain += positionGain;
            days++;

            let timeText = time.toISOString().split('T')[0];
            console.log(`${timeText},${callStrike},${putStrike},${positionGain}`);

            callStrike = 0;
            putStrike = 0;

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
    dataFolder: `${process.env.DATA_FOLDER}/${process.env.BVOL_SYMBOL}`,
    symbol: process.env.BVOL_SYMBOL || '',
    startTime: new Date(process.env.START_TIME || ''),
    endTime: new Date()
});
backtestData({
    dataFolder: `${process.env.DATA_FOLDER}/${process.env.SYMBOL}`,
    symbol: process.env.SYMBOL || '',
    startTime: new Date(process.env.START_TIME || ''),
    endTime: new Date(),
    callback: createCallback(iterator)
});

console.log(`total days: ${days} days with gain: ${daysWithGain}(${Math.round(daysWithGain / days * 100)}%) days with nothing: ${daysWithNothing}(${Math.round(daysWithNothing / days * 100)}%)`);
console.log(`net gain: ${totalGain} average gain: ${totalGain / days} largest loss: ${largestLoss} total loss: ${totalLoss} average loss: ${totalLoss / days}`);
console.log(`average call size: ${totalCallSize / optionCallDays} average put size: ${totalPutSize / optionPutDays}`);
console.log(`DONE`);
// console.log('Done');