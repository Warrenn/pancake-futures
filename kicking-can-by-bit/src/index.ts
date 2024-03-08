import { setTimeout as asyncSleep } from 'timers/promises';
import { OrderTriggerByV5, RestClientV5, WebsocketClient } from 'bybit-api'
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import dotenv from 'dotenv';
import { round } from './calculations.js';
import { Logger } from './logger.js';

const commission = 0.0002;
const precisionMap = new Map<string, SymbolPrecision>()
precisionMap.set('ETHPERP', { pricePrecision: 2, sizePrecision: 3 });
precisionMap.set('ETHUSDT', { pricePrecision: 2, sizePrecision: 3 });

type State = {
    bid: number
    ask: number
    price: number
    size: number
    entryPrice: number
    side: 'Buy' | 'Sell' | 'None'
    buyPrice: number
    sellPrice: number
    long: DirectionState
    short: DirectionState
    coolDownTimeout: number | undefined
}

type DirectionState = {
    orderId: string
    breakEvenPrice: number
    orderPrice: number
    threshold: number
    entryPrice: number
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
    longStrikePrice: number
    shortStrikePrice: number
    thresholdPercent: number
    slPercent: number
    coolDown: number
    symbol: string
    size: number
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
    if (topicParts[2] !== settings.symbol) return;
    if (data.data.b.length > 0 && data.data.b[0].length > 0) state.bid = parseFloat(data.data.b[0][0]);
    if (data.data.a.length > 0 && data.data.a[0].length > 0) state.ask = parseFloat(data.data.a[0][0]);
    let precision = precisionMap.get(settings.symbol)?.pricePrecision || 2;
    state.price = round((state.bid + state.ask) / 2, precision);
}

function positionUpdate(data: any, state: State, settings: Settings) {
    if (!data || !data.data || data.data.length < 0 || !data.data[0]) return;
    if (data.data[0].symbol !== settings.symbol) return;
    state.size = Math.abs(parseFloat(data.data[0].size));
    state.entryPrice = parseFloat(data.data[0].entryPrice);
    state.side = data.data[0].side;
}

function orderUpdate(data: any, state: State, settings: Settings) {
    if (!data || !data.data || data.data.length < 0 || !data.data[0]) return;
    if (data.data[0].stopOrderType !== '') return;
    if (data.data[0].symbol !== settings.symbol) return;
    let direction: DirectionState = data.data[0].side === 'Buy' ? state.long : state.short;
    switch (data.data[0].orderStatus) {
        case 'Cancelled':
        case 'Rejected':
        case 'Filled':
        case 'Deactivated':
            direction.orderId = '';
            break;
        case 'New':
            direction.orderId = data.data[0].orderId;
            break;
    }
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
            case 'position':
                positionUpdate(data, state, settings);
                break;
            case 'order':
                orderUpdate(data, state, settings);
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

async function tradingStrategy(context: Context) {
    let { state, settings, restClient } = context;
    let { bid, ask, price, side, size, long, short, entryPrice, coolDownTimeout } = state;

    let holdingLong = side === 'Buy' && size > 0;
    let holdingShort = side === 'Sell' && size > 0;
    let noPosition = size === 0;

    let longFilled = size >= settings.size && side === 'Buy';
    let shortFilled = size >= settings.size && side === 'Sell';

    let haveLongStrikePrice = settings.longStrikePrice > 0;
    let haveShortStrikePrice = settings.shortStrikePrice > 0;

    let haveCoolDownSetting = settings.coolDown > 0;
    let coolDownReady = !haveCoolDownSetting || (coolDownTimeout != undefined && (new Date()).getTime() >= coolDownTimeout);

    if (haveLongStrikePrice && long.threshold > 0 && holdingLong && price > long.threshold && state.sellPrice !== long.breakEvenPrice) {
        await Logger.log(`sell price set to ${long.breakEvenPrice} as price:${price} crossed threshold:${long.threshold} for long position`);
        state.sellPrice = long.breakEvenPrice;
    }
    if (haveShortStrikePrice && short.threshold > 0 && holdingShort && price < short.threshold && state.buyPrice !== short.breakEvenPrice) {
        await Logger.log(`buy price set to ${short.breakEvenPrice} as price:${price} crossed threshold:${short.threshold} for short position`);
        state.buyPrice = short.breakEvenPrice;
    }

    if (haveLongStrikePrice && price < settings.longStrikePrice && noPosition && state.buyPrice !== settings.longStrikePrice) {
        await Logger.log(`resetting long buy price, breakEvenPrice and threshold as price:${price} < strikePrice:${settings.longStrikePrice} and theres no position`);

        state.buyPrice = settings.longStrikePrice;
        long.orderId = ''
        long.orderPrice = 0;
        long.breakEvenPrice = 0;
        long.threshold = 0;
        long.entryPrice = 0;
    }

    if (haveShortStrikePrice && price > settings.shortStrikePrice && noPosition && state.sellPrice !== settings.shortStrikePrice) {
        await Logger.log(`resetting short sell price, breakEvenPrice and threshold as price:${price} > strikePrice:${settings.shortStrikePrice} and theres no position`);

        state.sellPrice = settings.shortStrikePrice;
        short.orderId = ''
        short.orderPrice = 0;
        short.breakEvenPrice = 0;
        short.threshold = 0;
        short.entryPrice = 0;
    }

    if (haveLongStrikePrice && long.entryPrice !== entryPrice && holdingLong) {
        long.entryPrice = entryPrice;
        long.breakEvenPrice = entryPrice + (entryPrice * 2 * commission);
        long.threshold = long.breakEvenPrice * (1 + settings.thresholdPercent);
        await Logger.log(`calculating long breakEvenPrice:${long.breakEvenPrice} and threshold:${long.threshold} entryPrice:${entryPrice}`);
    }

    if (haveLongStrikePrice && short.entryPrice !== entryPrice && holdingShort) {
        short.entryPrice = entryPrice;
        short.breakEvenPrice = entryPrice - (entryPrice * 2 * commission);
        short.threshold = short.breakEvenPrice * (1 - settings.thresholdPercent);
        await Logger.log(`calculating short breakEvenPrice:${short.breakEvenPrice} and threshold:${short.threshold} entryPrice:${entryPrice}`);
    }

    let mustSell = state.sellPrice > 0 && bid < state.sellPrice && !shortFilled;
    if (mustSell && short.orderId && short.orderPrice !== price && coolDownReady) {
        short.orderPrice = price;
        //update order
        let { retCode, retMsg } = await restClient.amendOrder({
            symbol: settings.symbol,
            category: 'linear',
            orderId: short.orderId,
            price: `${price}`
        });
        if (retCode === 0 && retMsg === 'OK') {
            await Logger.log(`ammend short order price:${price} symbol:${settings.symbol} orderId:${short.orderId}`);
        }
        else {
            short.orderId = '';
            await Logger.log(`failed to update short orderId:${short.orderId} retCode:${retCode} retMsg:${retMsg}`);
        }
        return;
    }
    if (!mustSell && short.orderId) {
        await restClient.cancelOrder({
            symbol: settings.symbol,
            category: 'linear',
            orderId: short.orderId
        });
        await Logger.log(`cancelling short order orderId:${short.orderId}`);
        short.orderId = '';
        return;
    }

    let orderSize = settings.size;
    let reduceOnly = false;
    let slTriggerBy: OrderTriggerByV5 | undefined = undefined;
    let stopLoss: string | undefined = undefined;

    if (mustSell && holdingLong) {
        orderSize = size;
        reduceOnly = true;
    }
    if (mustSell && !holdingLong && settings.slPercent > 0) {
        slTriggerBy = 'MarkPrice';
        stopLoss = `${price * (1 + settings.slPercent)}`;
    }

    if (mustSell && !short.orderId && coolDownReady) {
        let symbol = settings.symbol;
        short.orderPrice = price;
        let precision = precisionMap.get(symbol)?.sizePrecision || 3;
        let qty = `${round(orderSize, precision)}`;

        //create sell order
        let { retCode, retMsg, result: order } = await restClient.submitOrder({
            category: 'linear',
            symbol,
            side: 'Sell',
            orderType: 'Limit',
            timeInForce: 'PostOnly',
            price: `${price}`,
            reduceOnly,
            slTriggerBy,
            stopLoss,
            qty
        });
        if (retCode === 0 && retMsg === 'OK') {
            await Logger.log(`short sell order price:${price} qty:${qty} symbol:${symbol} orderId:${order.orderId}`);
            if (order.orderId) short.orderId = order.orderId;
        }
        else {
            await Logger.log(`short sell order failed price:${price} qty:${qty} symbol:${symbol} retCode:${retCode} reduceOnly:${reduceOnly} retMsg:${retMsg}`);
        }
        return;
    }

    let mustbuy = state.buyPrice > 0 && ask > state.buyPrice && !longFilled;
    if (mustbuy && long.orderId && long.orderPrice !== price && coolDownReady) {
        long.orderPrice = price;

        //update order
        let { retCode, retMsg } = await restClient.amendOrder({
            symbol: settings.symbol,
            category: 'linear',
            orderId: long.orderId,
            price: `${price}`
        });
        if (retCode === 0 && retMsg === 'OK') {
            await Logger.log(`ammend long order price:${price} symbol:${settings.symbol} orderId:${long.orderId}`);
        }
        else {
            long.orderId = '';
            await Logger.log(`failed to update long orderId:${long.orderId} retCode:${retCode} retMsg:${retMsg}`);
        }
        return;
    }

    if (!mustbuy && long.orderId) {
        await restClient.cancelOrder({
            symbol: settings.symbol,
            category: 'linear',
            orderId: long.orderId
        });
        await Logger.log(`cancelling long order orderId:${long.orderId}`);
        long.orderId = '';
        return;
    }

    orderSize = settings.size;
    reduceOnly = false
    slTriggerBy = undefined;
    stopLoss = undefined;

    if (mustbuy && holdingShort) {
        orderSize = size;
        reduceOnly = true;
    }
    if (mustbuy && !holdingLong && settings.slPercent > 0) {
        slTriggerBy = 'MarkPrice';
        stopLoss = `${price * (1 - settings.slPercent)}`;
    }

    if (mustbuy && !long.orderId && coolDownReady) {
        let symbol = settings.symbol;
        long.orderPrice = price;
        let precision = precisionMap.get(symbol)?.sizePrecision || 3;
        let qty = `${round(orderSize, precision)}`;

        //create buy order
        let { retCode, retMsg, result: order } = await restClient.submitOrder({
            category: 'linear',
            symbol,
            side: 'Buy',
            orderType: 'Limit',
            timeInForce: 'PostOnly',
            price: `${price}`,
            reduceOnly,
            slTriggerBy,
            stopLoss,
            qty
        });
        if (retCode === 0 && retMsg === 'OK') {
            await Logger.log(`long buy order price:${price} qty:${qty} symbol:${symbol} orderId:${order.orderId}`);
            if (order.orderId) long.orderId = order.orderId;
        }
        else {
            await Logger.log(`long buy order failed price:${price} qty:${qty} symbol:${symbol} reduceOnly:${reduceOnly} retCode:${retCode} retMsg:${retMsg}`);
        }
        return;
    }

    if (haveCoolDownSetting && coolDownTimeout === undefined && (mustSell || mustbuy)) state.coolDownTimeout = (new Date()).getTime() + settings.coolDown;
    if (haveCoolDownSetting && !mustSell && !mustbuy && coolDownTimeout !== undefined) state.coolDownTimeout = undefined;
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
        bid: 0,
        ask: 0,
        buyPrice: settings.longStrikePrice,
        entryPrice: 0,
        price: 0,
        sellPrice: settings.shortStrikePrice,
        side: 'None',
        size: 0,
        bounceCount: 0,
        coolDownTimeout: undefined,
        long: {
            breakEvenPrice: 0,
            orderId: '',
            orderPrice: 0,
            entryPrice: 0,
            threshold: 0
        },
        short: {
            breakEvenPrice: 0,
            orderId: '',
            orderPrice: 0,
            entryPrice: 0,
            threshold: 0
        }
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

    let { result: { list: orders } } = await restClient.getActiveOrders({
        symbol: settings.symbol,
        category: 'linear'
    });

    orders = orders?.filter(o => !o.triggerPrice && o.symbol === settings.symbol);
    for (let i = 0; i < orders?.length || 0; i++) {
        let order = orders[i];
        if (order.side === 'Buy') {
            state.long.orderId = order.orderId;
            state.long.orderPrice = parseFloat(order.price);
        }
        if (order.side === 'Sell') {
            state.short.orderId = order.orderId;
            state.short.orderPrice = parseFloat(order.price);
        }
    }

    let { result: { list: [position] } } = await restClient.getPositionInfo({
        symbol: settings.symbol,
        category: 'linear'
    });

    if (position && position.positionValue) {
        state.size = Math.abs(parseFloat(position.size));
        state.entryPrice = parseFloat(position.avgPrice);
        state.side = position.side
    }

    socketClient.on('update', websocketCallback(state, settings));

    await socketClient.subscribeV5(`orderbook.1.${settings.symbol}`, 'linear');
    await socketClient.subscribeV5('order', 'linear');
    await socketClient.subscribeV5('position', 'linear');

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