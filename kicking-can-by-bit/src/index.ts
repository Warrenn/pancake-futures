import { setTimeout as asyncSleep } from 'timers/promises';
import { RestClientV5, WebsocketClient } from 'bybit-api'
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import dotenv from 'dotenv';
import { round } from './calculations.js';
import { Logger } from './logger.js';

const commission = 0.0002;
const precisionMap = new Map<string, SymbolPrecision>()
precisionMap.set('ETHPERP', { pricePrecision: 2, sizePrecision: 3 });
precisionMap.set('ETHUSDT', { pricePrecision: 2, sizePrecision: 3 });

type OptionPositon = {
    symbol: string
    size: number
    strikePrice: number
    entryPrice: number
    type: 'Put' | 'Call'
}

type State = {
    bid: number
    ask: number
    price: number
    symbol: string
    nextExpiry: string
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
    apiKey: string
    apiSecret: string
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

function orderbookUpdate(data: any, state: State, settings: Settings) {
    if (!data || !data.data || !data.data.b || !data.data.a) return;
    let topicParts = data.topic.split('.');
    if (!topicParts || topicParts.length !== 3) return;
    if (topicParts[2] !== state.symbol) return;
    if (data.data.b.length > 0 && data.data.b[0].length > 0) state.bid = parseFloat(data.data.b[0][0]);
    if (data.data.a.length > 0 && data.data.a[0].length > 0) state.ask = parseFloat(data.data.a[0][0]);
    let precision = precisionMap.get(state.symbol)?.pricePrecision || 2;
    state.price = round((state.bid + state.ask) / 2, precision);
}

function websocketCallback(state: State, settings: Settings): (response: any) => void {
    return (data) => {
        if (!data.topic) return;
        let topic = data.topic.split('.');
        if (topic.length < 0) return;
        switch (topic[0]) {
            case 'orderbook':
                orderbookUpdate(data, state, settings);
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

function getNextExpiry() {
    let now = new Date();
    let currentHour = now.getUTCHours();
    let time = now.getTime();

    if (currentHour >= 8) time += 24 * 60 * 60 * 1000;//24 hours
    let expiryDate = new Date(time);
    let expiryYear = `${expiryDate.getUTCFullYear()}`.substring(2);
    let expiryMonth = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"][expiryDate.getUTCMonth()];
    return `${expiryDate.getDate()}${expiryMonth}${expiryYear}`;
}

async function buyBackOptions({ options, state, settings, restClient }: { options: OptionPositon[]; settings: Settings, state: State; restClient: RestClientV5; }): Promise<void> {
    for (let option of options) {
        let response = await restClient.getOrderbook({ symbol: option.symbol, category: 'option' });
        let askPrice = parseFloat(response.result.a[0][0]);
        let cost = (askPrice * option.size) + (option.strikePrice * option.size * commission);
        state.balance -= cost;
        await Logger.log(`buying back option: ${option.symbol} ask:${askPrice} cost:${cost} balance:${state.balance}`);
    }
    state.options = state.options.filter(o => !options.includes(o));
}

async function sellPutOption({ strikePrice, state, settings, restClient }: { strikePrice: number; settings: Settings, state: State; restClient: RestClientV5; }): Promise<void> {
    let symbol = `${settings.base}-${state.nextExpiry}-${strikePrice}-P`;
    let response = await restClient.getOrderbook({ symbol, category: 'option' });
    let bidPrice = parseFloat(response.result.b[0][0]);
    let income = bidPrice - (strikePrice * commission);
    state.balance += income;
    await Logger.log(`selling put option: ${symbol} bid:${bidPrice} income:${income} balance:${state.balance}`);
    state.options.push({
        symbol,
        size: 1,
        strikePrice,
        entryPrice: bidPrice,
        type: 'Put'
    });
}

async function sellCallOption({ strikePrice, settings, state, restClient }: { strikePrice: number; settings: Settings, state: State; restClient: RestClientV5; }): Promise<void> {
    let symbol = `${settings.base}-${state.nextExpiry}-${strikePrice}-C`;
    let response = await restClient.getOrderbook({ symbol, category: 'option' });
    let bidPrice = parseFloat(response.result.b[0][0]);
    let income = bidPrice - (strikePrice * commission);
    state.balance += income;
    await Logger.log(`selling call option: ${symbol} bid:${bidPrice} income:${income} balance:${state.balance}`);
    state.options.push({
        symbol,
        size: 1,
        strikePrice,
        entryPrice: bidPrice,
        type: 'Call'
    });
}

async function tradingStrategy(context: Context) {
    let { state, settings, restClient } = context;
    let { bid, ask } = state;

    if (bid < state.lowerStrikePrice && state.options.length > 0) {
        let nextLowerStrikePrice = state.lowerStrikePrice - (settings.stepSize * settings.stepOffset);
        let putOptions = state.options.filter(o => o.type === 'Put' && o.strikePrice === state.lowerStrikePrice);

        await buyBackOptions({
            options: putOptions,
            settings,
            state,
            restClient
        });

        await sellPutOption({
            strikePrice: nextLowerStrikePrice,
            settings,
            state,
            restClient
        });
        state.lowerStrikePrice = nextLowerStrikePrice;

        return;
    }

    if (ask > state.upperStrikePrice && state.options.length > 0) {
        let nextUpperStrikePrice = state.upperStrikePrice + (settings.stepSize * settings.stepOffset);
        let callOptions = state.options.filter(o => o.type === 'Call' && o.strikePrice === state.upperStrikePrice);

        await buyBackOptions({
            options: callOptions,
            settings,
            state,
            restClient
        });

        await sellCallOption({
            strikePrice: nextUpperStrikePrice,
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

    let nextExpiry = getNextExpiry();

    let state: State = {
        symbol: `${settings.base}${settings.quote}`,
        nextExpiry,
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
        key: apiCredentials.apiKey,
        secret: apiCredentials.apiSecret
    });

    const restClient = new RestClientV5({
        testnet: useTestNet,
        secret: apiCredentials.apiSecret,
        key: apiCredentials.apiKey
    });

    let response = await restClient.getOrderbook({ symbol: state.symbol, category: 'linear' });
    let price = (parseFloat(response.result.a[0][0]) + parseFloat(response.result.b[0][0])) / 2;
    let midPrice = round(price / settings.stepSize, 0) * settings.stepSize;
    state.upperStrikePrice = midPrice + settings.stepSize;
    state.lowerStrikePrice = midPrice - settings.stepSize;

    await sellCallOption({
        strikePrice: state.upperStrikePrice,
        state,
        settings,
        restClient
    });

    await sellPutOption({
        strikePrice: state.lowerStrikePrice,
        state,
        settings,
        restClient
    });

    socketClient.on('update', websocketCallback(state, settings));

    console.log(response);

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

