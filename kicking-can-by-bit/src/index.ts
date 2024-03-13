import { setTimeout as asyncSleep } from 'timers/promises';
import { RestClientV5, WebsocketClient } from 'bybit-api'
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import dotenv from 'dotenv';
import { round } from './calculations.js';
import { Logger } from './logger.js';

const commission = 0.0002;
const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const precisionMap = new Map<string, SymbolPrecision>()
precisionMap.set('ETHPERP', { pricePrecision: 2, sizePrecision: 3 });
precisionMap.set('ETHUSDT', { pricePrecision: 2, sizePrecision: 3 });
precisionMap.set('ETHOPT', { pricePrecision: 2, sizePrecision: 1 });

type OptionPositon = {
    symbol: string
    size: number
    expiry: Date
    strikePrice: number
    entryPrice: number
    type: 'Put' | 'Call'
}

type State = {
    bid: number
    ask: number
    price: number
    symbol: string
    nextExpiry: Date
    options: OptionPositon[]
    dailyBalance: number
    bounceCount: number
}

type SymbolPrecision = {
    sizePrecision: number
    pricePrecision: number
}

type Credentials = {
    key: string
    secret: string
}

type Settings = {
    stepSize: number
    stepOffset: number
    bounce: number
    base: string
    quote: string
    maxNotionalValue: number
    maxLoss: number
    targetProfit: number
}

type Context = {
    state: State
    settings: Settings
    restClient: RestClientV5
}

function orderbookUpdate(data: any, state: State) {
    if (!data || !data.data || !data.data.b || !data.data.a) return;
    let topicParts = data.topic.split('.');
    if (!topicParts || topicParts.length !== 3) return;
    if (topicParts[2] !== state.symbol) return;
    if (data.data.b.length > 0 && data.data.b[0].length > 0) state.bid = parseFloat(data.data.b[0][0]);
    if (data.data.a.length > 0 && data.data.a[0].length > 0) state.ask = parseFloat(data.data.a[0][0]);
    let precision = precisionMap.get(state.symbol)?.pricePrecision || 2;
    state.price = round((state.bid + state.ask) / 2, precision);
}

function websocketCallback(state: State): (response: any) => void {
    return (data) => {
        if (!data.topic) return;
        let topic = data.topic.split('.');
        if (topic.length < 0) return;
        switch (topic[0]) {
            case 'orderbook':
                orderbookUpdate(data, state);
                break;
        }
    }
}

async function getCredentials({ ssm, name, apiCredentialsKeyPrefix }: { ssm: SSMClient, name: string, apiCredentialsKeyPrefix: string }): Promise<Credentials> {
    let getCommand = new GetParameterCommand({ Name: `${apiCredentialsKeyPrefix}${name}`, WithDecryption: true });
    let ssmParam = await ssm.send(getCommand);
    return JSON.parse(`${ssmParam.Parameter?.Value}`);
}

async function getSettings({ ssm, name, keyPrefix }: { ssm: SSMClient, name: string, keyPrefix: string }): Promise<Settings> {
    let getCommand = new GetParameterCommand({ Name: `${keyPrefix}${name}` });
    let ssmParam = await ssm.send(getCommand);
    return JSON.parse(`${ssmParam.Parameter?.Value}`);
}

function getExpiryString(time: number) {
    let expiryDate = new Date(time);
    let expiryYear = `${expiryDate.getUTCFullYear()}`.substring(2);
    let expiryMonth = months[expiryDate.getUTCMonth()];
    return `${expiryDate.getDate()}${expiryMonth}${expiryYear}`;
}

function getNextExpiry() {
    let now = new Date();
    let time = now.getTime();
    if (now.getUTCHours() >= 8) time += 24 * 60 * 60 * 1000;
    let expiryDate = new Date(time);
    expiryDate.setUTCHours(8);
    expiryDate.setUTCMinutes(0);
    expiryDate.setUTCSeconds(0);
    expiryDate.setUTCMilliseconds(0);
    return expiryDate;
}

async function buyBackOptions({ options, state, settings, restClient }: { options: OptionPositon[]; state: State; settings: Settings; restClient: RestClientV5; }): Promise<number> {
    let totalCost = 0;
    for (let option of options) {
        let { retCode, retMsg, result } = await restClient.getOrderbook({ symbol: option.symbol, category: 'option' });
        if (retCode !== 0 || !result || !result.a || result.a.length === 0 || !result.a[0]) {
            await Logger.log(`error getting orderbook for option: ${option.symbol} retCode:${retCode} retMsg:${retMsg}`);
            continue;
        }
        let askPrice = parseFloat(result.a[0][0]);
        let sizePrecision = precisionMap.get(`${settings.base}OPT`)?.sizePrecision || 1;
        let qty = `${round(option.size, sizePrecision)}`;
        let cost = (askPrice * option.size) + (option.strikePrice * option.size * commission);

        if (settings.maxLoss > 0 && cost > settings.maxLoss) {
            Logger.log(`cant buy back option ${option.symbol} as cost: ${cost} exceeded maxLoss: ${settings.maxLoss}`);
            continue;
        }

        // ({ retCode, retMsg } = await restClient.submitOrder({
        //     symbol: option.symbol,
        //     side: 'Buy',
        //     orderType: 'Market',
        //     timeInForce: 'GTC',
        //     qty,
        //     category: 'option',
        //     reduceOnly: true
        // }));

        if (retCode === 0 && retMsg === 'OK') {
            state.dailyBalance -= cost;
            totalCost += cost;

            await Logger.log(`buying back option: ${option.symbol} ask:${askPrice} size:${option.size} strikePrice:${option.strikePrice} cost:${cost} balance:${state.dailyBalance}`);
        }
        else {
            await Logger.log(`error buying back option: ${option.symbol} retCode:${retCode} retMsg:${retMsg}`);
        }
    }
    state.options = state.options.filter(o => !options.includes(o));
    return totalCost;
}

async function sellPutOption({ strikePrice, nextExpiry, targetProfit, state, settings, restClient }: { strikePrice: number; nextExpiry: Date, targetProfit: number, settings: Settings, state: State; restClient: RestClientV5; }): Promise<void> {
    if (targetProfit <= 0) return;
    let expiryString = getExpiryString(nextExpiry.getTime());
    let symbol = `${settings.base}-${expiryString}-${strikePrice}-P`;
    let { retCode, retMsg, result } = await restClient.getOrderbook({ symbol, category: 'option' });
    if (retCode !== 0 || !result || !result.b || result.b.length === 0) {
        await Logger.log(`error getting orderbook for put option: ${symbol} retCode:${retCode} retMsg:${retMsg}`);
        return;
    }
    let bidPrice = parseFloat(result.b[0][0]);
    let income = bidPrice - (strikePrice * commission);
    let sizePrecision = precisionMap.get(`${settings.base}OPT`)?.sizePrecision || 1;
    let size = round(targetProfit / income, sizePrecision);
    let notionalValue = size * strikePrice;

    if (settings.maxNotionalValue > 0 && notionalValue > settings.maxNotionalValue) {
        Logger.log(`cant sell put ${symbol} as notionalValue: ${notionalValue} exceeded maxNotionalValue: ${settings.maxNotionalValue}`);
        return;
    }
    let qty = `${size}`;

    // let { retCode, retMsg } = await restClient.submitOrder({
    //     symbol,
    //     side: 'Sell',
    //     orderType: 'Market',
    //     timeInForce: 'GTC',
    //     qty,
    //     category: 'option'
    // });

    if (retCode === 0) {
        state.dailyBalance += size * income;
        state.bounceCount++;
        await Logger.log(`selling put option: ${symbol} bid:${bidPrice} income:${income} targetProfit:${targetProfit} size:${size} strikePrice:${strikePrice} balance:${state.dailyBalance}`);
        state.options.push({
            symbol,
            size: size,
            strikePrice,
            expiry: nextExpiry,
            entryPrice: bidPrice,
            type: 'Put'
        });
    }
    else {
        await Logger.log(`error selling put option: ${symbol} retCode:${retCode} retMsg:${retMsg}`);
    }
}

async function sellCallOption({ strikePrice, nextExpiry, targetProfit, settings, state, restClient }: { strikePrice: number; nextExpiry: Date; targetProfit: number; settings: Settings, state: State; restClient: RestClientV5; }): Promise<void> {
    if (targetProfit <= 0) return;
    let expiryString = getExpiryString(nextExpiry.getTime());
    let symbol = `${settings.base}-${expiryString}-${strikePrice}-C`;
    let { retCode, retMsg, result } = await restClient.getOrderbook({ symbol, category: 'option' });
    if (retCode !== 0 || !result || !result.b || result.b.length === 0) {
        await Logger.log(`error getting orderbook for call option: ${symbol} retCode:${retCode} retMsg:${retMsg}`);
        return;
    }
    let bidPrice = parseFloat(result.b[0][0]);
    let income = bidPrice - (strikePrice * commission);
    let sizePrecision = precisionMap.get(`${settings.base}OPT`)?.sizePrecision || 1;
    let size = round(targetProfit / income, sizePrecision);
    let notionalValue = size * strikePrice;

    if (settings.maxNotionalValue > 0 && notionalValue > settings.maxNotionalValue) {
        Logger.log(`cant sell call ${symbol} as notionalValue: ${notionalValue} exceeded maxNotionalValue: ${settings.maxNotionalValue}`);
        return;
    }
    let qty = `${size}`;

    // ({ retCode, retMsg } = await restClient.submitOrder({
    //     symbol,
    //     side: 'Sell',
    //     orderType: 'Market',
    //     timeInForce: 'GTC',
    //     qty,
    //     category: 'option'
    // }));

    if (retCode === 0) {
        state.dailyBalance += size * income;
        state.bounceCount++;
        await Logger.log(`selling call option: ${symbol} bid:${bidPrice} income:${income} targetProfit:${targetProfit} size:${size} strikePrice:${strikePrice} balance:${state.dailyBalance}`);
        state.options.push({
            symbol,
            size: size,
            strikePrice,
            expiry: nextExpiry,
            entryPrice: bidPrice,
            type: 'Call'
        });
    } else {
        await Logger.log(`error selling call option: ${symbol} retCode:${retCode} retMsg:${retMsg}`);
    }
}

async function getOptions({ restClient, settings }: { restClient: RestClientV5; settings: Settings }): Promise<OptionPositon[]> {
    let
        baseCurrency = settings.base,
        { result: { list } } = await restClient.getPositionInfo({ category: "option", baseCoin: baseCurrency }),
        checkExpression = new RegExp(`^${baseCurrency}-(\\d+)(\\w{3})(\\d{2})-(\\d*)-(P|C)$`),
        options: OptionPositon[] = []

    for (let c = 0; c < (list || []).length; c++) {
        let optionPosition = list[c];
        let matches = optionPosition.symbol.match(checkExpression);

        if (!matches) continue;
        if (parseFloat(optionPosition.size) == 0) continue;
        let strikePrice = parseFloat(matches[4]);
        let type: 'Put' | 'Call' = matches[5] === 'P' ? 'Put' : 'Call';
        let mIndex = months.indexOf(matches[2]);
        let expiry = new Date();
        let newYear = parseInt(`20${matches[3]}`);
        expiry.setUTCDate(parseInt(matches[1]));
        expiry.setUTCHours(8);
        expiry.setUTCMinutes(0);
        expiry.setUTCSeconds(0);
        expiry.setUTCMilliseconds(0);
        expiry.setUTCMonth(mIndex);
        expiry.setUTCFullYear(newYear);
        options.push({
            symbol: optionPosition.symbol,
            size: parseFloat(optionPosition.size),
            expiry,
            strikePrice,
            entryPrice: parseFloat(optionPosition.avgPrice),
            type
        });
    }

    return options;
}

async function tradingStrategy(context: Context) {
    let { state, settings, restClient } = context;
    let { bid, ask, price } = state;

    let nextExpiry = getNextExpiry();
    let nextTime = nextExpiry.getTime();

    if (nextTime !== state.nextExpiry.getTime()) {
        state.nextExpiry = nextExpiry;
        state.dailyBalance = 0;
        state.options = state.options?.filter(o => o.expiry.getTime() >= nextTime) || [];
        return;
    }

    let upperStrikePrice: number | undefined = undefined;
    let lowerStrikePrice: number | undefined = undefined;
    let nextOptions = state.options?.filter(o => o.expiry.getTime() === nextTime) || [];

    for (let i = 0; i < nextOptions.length; i++) {
        let option = nextOptions[i];
        if (option.type === 'Call' && (upperStrikePrice === undefined || option.strikePrice < upperStrikePrice)) upperStrikePrice = option.strikePrice;
        if (option.type === 'Put' && (lowerStrikePrice === undefined || option.strikePrice > lowerStrikePrice)) lowerStrikePrice = option.strikePrice;
    }

    let buyBackCallOptions = nextOptions.filter(o => upperStrikePrice !== undefined && o.type === 'Call' && o.strikePrice <= upperStrikePrice && ask > upperStrikePrice);
    let buyBackPutOptions = nextOptions.filter(o => lowerStrikePrice !== undefined && o.type === 'Put' && o.strikePrice >= lowerStrikePrice && bid < lowerStrikePrice);

    if (buyBackPutOptions.length > 0) {
        let cost = await buyBackOptions({
            options: buyBackPutOptions,
            settings,
            state,
            restClient
        });
        state.dailyBalance -= cost;
        return;
    }

    if (buyBackCallOptions.length > 0) {
        let cost = await buyBackOptions({
            options: buyBackCallOptions,
            settings,
            state,
            restClient
        });
        state.dailyBalance -= cost;
        return;
    }

    let targetProfit = settings.targetProfit - state.dailyBalance;
    if (targetProfit <= 0) return;

    if (lowerStrikePrice === undefined && upperStrikePrice === undefined) {
        let midPrice = round(price / settings.stepSize, 0) * settings.stepSize;
        let offset = settings.stepSize * settings.stepOffset;

        let priceIsBelowMid = price < midPrice;
        if (state.bounceCount > settings.bounce) state.bounceCount = 0;

        let shiftStrikePriceByOffset = state.bounceCount === 0;
        if (priceIsBelowMid && shiftStrikePriceByOffset) lowerStrikePrice = midPrice - offset;
        if (priceIsBelowMid && !shiftStrikePriceByOffset) upperStrikePrice = midPrice + offset;
        if (!priceIsBelowMid && shiftStrikePriceByOffset) upperStrikePrice = midPrice + offset;
        if (!priceIsBelowMid && !shiftStrikePriceByOffset) lowerStrikePrice = midPrice - offset;
    }

    if (upperStrikePrice !== undefined) {
        await sellCallOption({
            strikePrice: upperStrikePrice,
            targetProfit,
            nextExpiry,
            state,
            settings,
            restClient
        });
        return;
    }

    if (lowerStrikePrice !== undefined) {
        await sellPutOption({
            strikePrice: lowerStrikePrice,
            targetProfit,
            nextExpiry,
            state,
            settings,
            restClient
        });
        return;
    }
}

dotenv.config({ override: true });

await Logger.logVersion();
await Logger.log('starting');

const
    keyPrefix = `${process.env.KEY_PREFIX}`,
    region = `${process.env.AWS_REGION}`,
    useTestNet = process.env.USE_TESTNET === 'true';

try {
    const ssm = new SSMClient({ region });
    const apiCredentials = await getCredentials({ ssm, name: 'api-credentials', apiCredentialsKeyPrefix: keyPrefix });
    const settings = await getSettings({ ssm, name: 'settings', keyPrefix });

    const socketClient = new WebsocketClient({
        market: 'v5',
        testnet: useTestNet,
        key: apiCredentials.key,
        secret: apiCredentials.secret
    });

    const restClient = new RestClientV5({
        testnet: useTestNet,
        secret: apiCredentials.secret,
        key: apiCredentials.key
    });

    let options = await getOptions({ settings, restClient });
    let state: State = {
        symbol: `${settings.base}${settings.quote}`,
        nextExpiry: getNextExpiry(),
        dailyBalance: 0,
        options,
        bid: 0,
        ask: 0,
        price: 0,
        bounceCount: 0
    } as State;

    socketClient.on('update', websocketCallback(state));

    await socketClient.subscribeV5(`orderbook.1.${state.symbol}`, 'linear');

    await Logger.log(`state: ${JSON.stringify(state)}`);
    await Logger.log(`settings: ${JSON.stringify(settings)}`);

    let context: Context = {
        state,
        settings,
        restClient
    }

    while (true) {
        try {
            await tradingStrategy(context);
            await asyncSleep(1000);
        }
        catch (error) {
            let err = error as Error;
            await Logger.log(`error: message:${err.message} stack:${err.stack}`);
        }
    }
}
catch (error) {
    let err = error as Error;
    await Logger.log(`error: message:${err.message} stack:${err.stack}`);
    process.exit(1);
}


