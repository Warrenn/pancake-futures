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
    nextExpiry: Date | undefined
    options: OptionPositon[]
    balance: number
    upperStrikePrice: number
    lowerStrikePrice: number
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
    base: string
    quote: string
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

async function buyBackOptions({ options, state, restClient }: { options: OptionPositon[]; state: State; restClient: RestClientV5; }): Promise<number> {
    let totalCost = 0;
    for (let option of options) {
        let response = await restClient.getOrderbook({ symbol: option.symbol, category: 'option' });
        let askPrice = parseFloat(response.result.a[0][0]);
        let cost = (askPrice * option.size) + (option.strikePrice * option.size * commission);
        state.balance -= cost;
        totalCost += cost;
        await Logger.log(`buying back option: ${option.symbol} ask:${askPrice} size:${option.size} strikePrice:${option.strikePrice} cost:${cost} balance:${state.balance}`);
    }
    state.options = state.options.filter(o => !options.includes(o));
    return totalCost;
}

async function sellPutOption({ strikePrice, nextExpiry, targetProfit, state, settings, restClient }: { strikePrice: number; nextExpiry: Date, targetProfit: number, settings: Settings, state: State; restClient: RestClientV5; }): Promise<void> {
    let expiryString = getExpiryString(nextExpiry.getTime());
    let symbol = `${settings.base}-${expiryString}-${strikePrice}-P`;
    let response = await restClient.getOrderbook({ symbol, category: 'option' });
    let bidPrice = parseFloat(response.result.b[0][0]);
    let income = bidPrice - (strikePrice * commission);
    let sizePrecision = precisionMap.get(`${settings.base}OPT`)?.sizePrecision || 1;
    let size = round(targetProfit / income, sizePrecision);

    state.balance += size * income;
    await Logger.log(`selling put option: ${symbol} bid:${bidPrice} income:${income} targetProfit:${targetProfit} size:${size} strikePrice:${strikePrice} balance:${state.balance}`);
    state.options.push({
        symbol,
        size: size,
        strikePrice,
        expiry: nextExpiry,
        entryPrice: bidPrice,
        type: 'Put'
    });
}

async function sellCallOption({ strikePrice, nextExpiry, targetProfit, settings, state, restClient }: { strikePrice: number; nextExpiry: Date; targetProfit: number; settings: Settings, state: State; restClient: RestClientV5; }): Promise<void> {
    let expiryString = getExpiryString(nextExpiry.getTime());
    let symbol = `${settings.base}-${expiryString}-${strikePrice}-C`;
    let response = await restClient.getOrderbook({ symbol, category: 'option' });
    let bidPrice = parseFloat(response.result.b[0][0]);

    let income = bidPrice - (strikePrice * commission);
    let sizePrecision = precisionMap.get(`${settings.base}OPT`)?.sizePrecision || 1;
    let size = round(targetProfit / income, sizePrecision);
    state.balance += size * income;
    await Logger.log(`selling call option: ${symbol} bid:${bidPrice} income:${income} targetProfit:${targetProfit} size:${size} strikePrice:${strikePrice} balance:${state.balance}`);
    state.options.push({
        symbol,
        size: size,
        strikePrice,
        expiry: nextExpiry,
        entryPrice: bidPrice,
        type: 'Call'
    });
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
    let nextOptions = state.options?.filter(o => o.expiry.getTime() == nextTime) || [];

    if (state.nextExpiry === undefined || nextExpiry.getTime() !== state.nextExpiry.getTime()) {
        state.nextExpiry = nextExpiry;

        if (!nextOptions || nextOptions.length === 0) {
            let midPrice = round(price / settings.stepSize, 0) * settings.stepSize;
            let offset = settings.stepSize * settings.stepOffset;
            state.upperStrikePrice = midPrice + offset;
            state.lowerStrikePrice = midPrice - offset;
            let halfProfit = settings.targetProfit / 2;

            await sellCallOption({
                strikePrice: state.upperStrikePrice,
                targetProfit: halfProfit,
                nextExpiry,
                state,
                settings,
                restClient
            });

            await sellPutOption({
                strikePrice: state.lowerStrikePrice,
                targetProfit: halfProfit,
                nextExpiry,
                state,
                settings,
                restClient
            });
        }
        else {
            state.upperStrikePrice = 0;
            state.lowerStrikePrice = 0;
            for (let i = 0; i < nextOptions.length; i++) {
                let option = nextOptions[i];
                if (option.type === 'Call' && (state.upperStrikePrice === 0 || option.strikePrice < state.upperStrikePrice)) state.upperStrikePrice = option.strikePrice;
                if (option.type === 'Put' && (state.lowerStrikePrice === 0 || option.strikePrice > state.lowerStrikePrice)) state.lowerStrikePrice = option.strikePrice;
            }
        }

        return;
    }

    if (bid < state.lowerStrikePrice) {
        let nextLowerStrikePrice = state.lowerStrikePrice - (settings.stepSize * settings.stepOffset);
        let putOptions = nextOptions.filter(o => o.type === 'Put' && o.strikePrice >= state.lowerStrikePrice);

        let cost = await buyBackOptions({
            options: putOptions,
            state,
            restClient
        });

        await sellPutOption({
            strikePrice: nextLowerStrikePrice,
            nextExpiry,
            targetProfit: cost,
            settings,
            state,
            restClient
        });
        state.lowerStrikePrice = nextLowerStrikePrice;

        return;
    }

    if (ask > state.upperStrikePrice) {
        let nextUpperStrikePrice = state.upperStrikePrice + (settings.stepSize * settings.stepOffset);
        let callOptions = nextOptions.filter(o => o.type === 'Call' && o.strikePrice <= state.upperStrikePrice);

        let cost = await buyBackOptions({
            options: callOptions,
            state,
            restClient
        });

        await sellCallOption({
            strikePrice: nextUpperStrikePrice,
            nextExpiry,
            targetProfit: cost,
            settings,
            state,
            restClient
        });
        state.upperStrikePrice = nextUpperStrikePrice;

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

    let state: State = {
        symbol: `${settings.base}${settings.quote}`,
        nextExpiry: undefined,
        balance: 0,
        options: [],
        bid: 0,
        ask: 0,
        lowerStrikePrice: 0,
        upperStrikePrice: 0,
        price: 0
    } as State;

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
    state.options = options;

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
        await tradingStrategy(context);
        await asyncSleep(10);
    }
}
catch (error) {
    let err = error as Error;
    await Logger.log(`error: message:${err.message} stack:${err.stack}`);
    process.exit(1);
}

