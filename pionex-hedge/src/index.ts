import { setTimeout as asyncSleep } from 'timers/promises';
import { WebsocketClient, UnifiedMarginClient } from "bybit-api";
import { v4 as uuid } from 'uuid';
import AWS from 'aws-sdk';
import dotenv from "dotenv";

type OptionPosition = { symbol: string, markPrice: string, unrealisedPnl: string, entryPrice: string, size: string, limit: number };

dotenv.config({ override: true });

const
    months = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"],
    credentialsKey = `${process.env.PIONEX_API_CREDENTIALS}`,
    settingsKey = `${process.env.PIONEX_SETTINGS}`,
    region = `${process.env.PIONEX_REGION}`;

let
    symbol: string = '',
    baseCurrency: string = '',
    quoteCurrency: string = '',
    optionInterval: number = 0,
    optionPrecision: number = 0,
    quotePrecision: number = 0,
    logFrequency: number = 0,
    useTestnet: boolean = false,
    quoteSize: number = 0,
    fallRatio: number = 0,
    safetyMargin: number = 0;

let
    currentMoment: Date,
    optionSize: number = 0,
    expiry: Date | null = null,
    unifiedClient: UnifiedMarginClient,
    wsSpot: WebsocketClient | null = null,
    optionsNeedUpdate: boolean = false,
    putOption: OptionPosition | null = null,
    price: number = 0,
    strikePrice: number = 0,
    putSymbol: string = '',
    logCount: number = 0,
    ssm: AWS.SSM | null = null;

function floor(num: number, precision: number = quotePrecision) {
    let exp = Math.pow(10, precision);
    return Math.floor((+num * exp)) / exp;
}

async function log(message: string) {
    let logLine = `${(new Date()).toISOString()} ${message}`;
    console.log(logLine);
}

async function consoleAndFile(message: string) {
    console.log(message);
    console.error(message);
}

async function logError(message: string) {
    await consoleAndFile((new Date()).toISOString());
    await consoleAndFile(message);
}

function getPutSymbol(price: number): {
    putSymbol: string,
    strikePrice: number,
    expiry: Date
} {
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

async function buyPutOrder(size: number, putSymbol: string) {
    if (size < 0.001) return;
    size = floor(size, optionPrecision);
    var { retCode, retMsg } = await unifiedClient.submitOrder({
        category: 'option',
        orderType: 'Market',
        side: 'Buy',
        qty: `${size}`,
        symbol: putSymbol,
        timeInForce: 'ImmediateOrCancel',
        orderLinkId: `${uuid()}`
    });
    if (retCode != 0) logError(`put order failed ${putSymbol} ${size} (${retCode}) failed ${retCode} ${retMsg}`);
    optionsNeedUpdate = true;
}

async function executeTrade({
    optionSize,
    price,
    strikePrice,
    putOption,
    putSymbol
}: {
    optionSize: number,
    price: number,
    strikePrice: number,
    putOption: OptionPosition | null,
    putSymbol: string
}) {

    if ((logCount % logFrequency) == 0) {
        log(`price:${price} sp:${strikePrice} s:${optionSize} p(${putSymbol}):${putOption?.unrealisedPnl}`);
        logCount = 1;
    }
    else logCount++;

    if (!putSymbol || strikePrice == 0) ({ putSymbol, strikePrice } = getPutSymbol(price));
    let limit = strikePrice * (1 + safetyMargin);
    if (putOption || price == 0 || price > limit) return;

    log(`buying put ${putSymbol} price:${price} limit:${limit} size:${optionSize})`);
    await buyPutOrder(optionSize, putSymbol);
}

async function getOptions(): Promise<{
    putOption: OptionPosition | null,
    expiry: Date | null
}> {
    let
        { result: { list } } = await unifiedClient.getPositions({ category: "option", baseCoin: baseCurrency }),
        checkExpression = new RegExp(`^${baseCurrency}-(\\d+)(\\w{3})(\\d{2})-(\\d*)-(P|C)$`),
        putOption: OptionPosition | null = null,
        expiry: Date | null = null;

    for (let c = 0; c < (list || []).length; c++) {
        let optionPosition = <OptionPosition>list[c];
        let matches = optionPosition.symbol.match(checkExpression);

        if (!matches) continue;
        if (parseFloat(optionPosition.size) == 0) continue;
        optionPosition.limit = parseFloat(matches[4]);

        if (matches[5] == 'P') putOption = optionPosition;
        if (expiry != null) continue;

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

function closeWebSocket(socket: WebsocketClient | null) {
    try {
        if (socket == null) return;
        socket.closeAll(true);
    } catch (err) {
        logError(`couldnt close socket: ${err}`);
    }
}

process.stdin.on('data', process.exit.bind(process, 0));
ssm = new AWS.SSM({ region });

let authenticationParameter = await ssm.getParameter({ Name: credentialsKey, WithDecryption: true }).promise();
const { key, secret } = JSON.parse(`${authenticationParameter.Parameter?.Value}`);

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
} = JSON.parse(`${settingsParameter.Parameter?.Value}`));

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

        wsSpot.on('update', (data: any) => {
            if (data?.topic == `bookticker.${symbol}` && data.data?.ap && data.data?.bp) {
                price = floor(data.data?.bp, quotePrecision);
            }
        });

        wsSpot.subscribe([`bookticker.${symbol}`]);
        ({ putOption, expiry } = await getOptions());
        if (putOption) {
            putSymbol = putOption.symbol;
            strikePrice = putOption.limit;
        } else {
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

            if (optionSize == 0 && price > 0) optionSize = floor(quoteSize / price, optionPrecision);

            if (optionsNeedUpdate) {
                ({ putOption } = await getOptions());
                optionsNeedUpdate = false;
            }

            if (!putSymbol || strikePrice == 0 || expiry == null) ({ putSymbol, strikePrice, expiry } = getPutSymbol(price));

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
        } catch (lerr) {
            console.error(lerr);
        }
    }
}