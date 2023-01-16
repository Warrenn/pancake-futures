var _a, _b;
import { setTimeout as asyncSleep } from 'timers/promises';
import { WebsocketClient, UnifiedMarginClient } from "bybit-api";
import AWS from 'aws-sdk';
import dotenv from "dotenv";
dotenv.config({ override: true });
const months = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"], credentialsKey = `${process.env.PIONEX_API_CREDENTIALS}`, settingsKey = `${process.env.PIONEX_SETTINGS}`, region = `${process.env.PIONEX_REGION}`;
let symbol = '', baseCurrency = '', quoteCurrency = '', optionInterval = 0, optionPrecision = 0, quotePrecision = 0, logFrequency = 0, useTestnet = false, quoteSize = 0, fallRatio = 0, safetyMargin = 0;
let currentMoment, optionSize = 0, expiry = null, unifiedClient, wsSpot = null, optionsNeedUpdate = false, putOption = null, price = 0, strikePrice = 0, putSymbol = '', logCount = 0, ssm = null;
function floor(num, precision = quotePrecision) {
    let exp = Math.pow(10, precision);
    return Math.floor((+num * exp)) / exp;
}
async function log(message) {
    let logLine = `${(new Date()).toISOString()} ${message}`;
    console.log(logLine);
}
async function consoleAndFile(message) {
    console.log(message);
    console.error(message);
}
async function logError(message) {
    await consoleAndFile((new Date()).toISOString());
    await consoleAndFile(message);
}
function getPutSymbol(price) {
    let fallPrice = price * (1 - fallRatio);
    let strikePrice = Math.floor(fallPrice / optionInterval) * optionInterval;
    let expiry = new Date();
    expiry.setUTCDate(expiry.getUTCDate() + ((expiry.getUTCHours() < 8) ? 0 : 1));
    expiry.setUTCHours(8);
    expiry.setUTCMinutes(0);
    expiry.setUTCSeconds(0);
    expiry.setUTCMilliseconds(0);
    let yearStr = `${expiry.getUTCFullYear()}`;
    yearStr = yearStr.substring(yearStr.length - 2);
    return {
        putSymbol: `${baseCurrency}-${expiry.getUTCDate()}${months[expiry.getUTCMonth()]}${yearStr}-${strikePrice}-P`,
        strikePrice,
        expiry
    };
}
async function buyPutOrder(size, putSymbol) {
    if (size < 0.001)
        return;
    size = floor(size, optionPrecision);
    // var { retCode, retMsg } = await unifiedClient.submitOrder({
    //     category: 'option',
    //     orderType: 'Market',
    //     side: 'Buy',
    //     qty: `${size}`,
    //     symbol: putSymbol,
    //     timeInForce: 'ImmediateOrCancel',
    //     orderLinkId: `${uuid()}`
    // });
    // if (retCode != 0) logError(`put order failed ${putSymbol} ${size} (${retCode}) failed ${retCode} ${retMsg}`);
    optionsNeedUpdate = true;
}
async function executeTrade({ optionSize, price, strikePrice, putOption, putSymbol }) {
    if ((logCount % logFrequency) == 0) {
        log(`price:${price} sp:${strikePrice} q:${optionSize} p(${putOption === null || putOption === void 0 ? void 0 : putOption.symbol}):${putOption === null || putOption === void 0 ? void 0 : putOption.unrealisedPnl}`);
        logCount = 1;
    }
    else
        logCount++;
    if (!putSymbol || strikePrice == 0)
        ({ putSymbol, strikePrice } = getPutSymbol(price));
    let limit = strikePrice * (1 + safetyMargin);
    if (putOption || price == 0 || price > limit)
        return;
    await buyPutOrder(optionSize, putSymbol);
}
async function getOptions() {
    let { result: { list } } = await unifiedClient.getPositions({ category: "option", baseCoin: baseCurrency }), checkExpression = new RegExp(`^${baseCurrency}-(\\d+)(\\w{3})(\\d{2})-(\\d*)-(P|C)$`), putOption = null, expiry = null;
    for (let c = 0; c < (list || []).length; c++) {
        let optionPosition = list[c];
        let matches = optionPosition.symbol.match(checkExpression);
        if (!matches)
            continue;
        if (parseFloat(optionPosition.size) == 0)
            continue;
        optionPosition.limit = parseFloat(matches[4]);
        if (matches[5] == 'P')
            putOption = optionPosition;
        if (expiry != null)
            continue;
        let mIndex = months.indexOf(matches[2]);
        expiry = new Date();
        let newYear = parseInt(`20${matches[3]}`);
        expiry.setUTCDate(parseInt(matches[1]));
        expiry.setUTCHours(8);
        expiry.setUTCMinutes(0);
        expiry.setUTCSeconds(0);
        expiry.setUTCMilliseconds(0);
        expiry.setUTCMonth(mIndex);
        expiry.setUTCFullYear(newYear);
    }
    return { putOption, expiry };
}
function closeWebSocket(socket) {
    try {
        if (socket == null)
            return;
        socket.closeAll(true);
    }
    catch (err) {
        logError(`couldnt close socket: ${err}`);
    }
}
process.stdin.on('data', process.exit.bind(process, 0));
ssm = new AWS.SSM({ region });
let authenticationParameter = await ssm.getParameter({ Name: credentialsKey, WithDecryption: true }).promise();
const { key, secret } = JSON.parse(`${(_a = authenticationParameter.Parameter) === null || _a === void 0 ? void 0 : _a.Value}`);
let settingsParameter = await ssm.getParameter({ Name: settingsKey }).promise();
({
    baseCurrency,
    quoteCurrency,
    optionInterval,
    optionPrecision,
    quotePrecision,
    logFrequency,
    useTestnet,
    quoteSize,
    fallRatio,
    safetyMargin
} = JSON.parse(`${(_b = settingsParameter.Parameter) === null || _b === void 0 ? void 0 : _b.Value}`));
symbol = `${baseCurrency}${quoteCurrency}`;
while (true) {
    try {
        unifiedClient = new UnifiedMarginClient({
            testnet: useTestnet,
            key: key,
            secret: secret,
            recv_window: 999999
        });
        wsSpot = new WebsocketClient({
            testnet: useTestnet,
            key: key,
            secret: secret,
            fetchTimeOffsetBeforeAuth: true,
            market: 'spotv3'
        });
        wsSpot.on('update', (data) => {
            var _a, _b, _c;
            if ((data === null || data === void 0 ? void 0 : data.topic) == `bookticker.${symbol}` && ((_a = data.data) === null || _a === void 0 ? void 0 : _a.ap) && ((_b = data.data) === null || _b === void 0 ? void 0 : _b.bp)) {
                price = floor((_c = data.data) === null || _c === void 0 ? void 0 : _c.bp, quotePrecision);
            }
        });
        wsSpot.subscribe([`bookticker.${symbol}`]);
        ({ putOption, expiry } = await getOptions());
        if (putOption) {
            putSymbol = putOption.symbol;
            strikePrice = putOption.limit;
        }
        else {
            ({ putSymbol, strikePrice } = getPutSymbol(price));
        }
        while (true) {
            await asyncSleep(100);
            currentMoment = new Date();
            if (expiry && currentMoment > expiry) {
                optionsNeedUpdate = true;
                ({ putSymbol, strikePrice, expiry } = getPutSymbol(price));
                putOption = null;
                continue;
            }
            if (optionSize == 0 && price > 0)
                optionSize = floor(quoteSize / price, optionPrecision);
            if (optionsNeedUpdate) {
                ({ putOption } = await getOptions());
                optionsNeedUpdate = false;
            }
            if (!putSymbol || strikePrice == 0 || expiry == null)
                ({ putSymbol, strikePrice, expiry } = getPutSymbol(price));
            await executeTrade({
                optionSize,
                price,
                strikePrice,
                putOption,
                putSymbol
            });
        }
    }
    catch (err) {
        try {
            await logError(`${err}`);
            closeWebSocket(wsSpot);
        }
        catch (lerr) {
            console.error(lerr);
        }
    }
}
//# sourceMappingURL=index.js.map