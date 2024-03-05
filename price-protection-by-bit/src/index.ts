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

type State = {
    bid: number
    ask: number
    price: number
    size: number
    entryPrice: number
    side: 'Buy' | 'Sell' | 'None'
    bounceCount: number
    long: DirectionState
    short: DirectionState
}

type DirectionState = {
    orderId: string
    breakEvenPrice: number
    orderPrice: number
    threshold: number
    crossedThreshold: boolean
    strikePrice: number
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
    maxBounceCount: number
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
    let { bid, ask, price, side, size, long, short, entryPrice, bounceCount } = state;
    let overbought = size > settings.size && side === 'Buy' && price > settings.longStrikePrice;
    let oversold = size > settings.size && side === 'Sell' && price < settings.shortStrikePrice;
    let holdingLong = side === 'Buy' && size > 0;
    let holdingShort = side === 'Sell' && size > 0;
    let noPosition = size === 0;

    let longFilled = size === settings.size && side === 'Buy';
    let shortFilled = size === settings.size && side === 'Sell';

    if (long.crossedThreshold && (noPosition || side === 'Sell')) {
        long.crossedThreshold = false;
        await Logger.log(`long crossedThreshold reset noPosition:${noPosition} side:${side}`);
    }
    if (short.crossedThreshold && (noPosition || side === 'Buy')) {
        short.crossedThreshold = false;
        await Logger.log(`short crossedThreshold reset noPosition:${noPosition} side:${side}`);
    }

    if (long.threshold > 0 && price > long.threshold && !long.crossedThreshold && side === 'Buy') {
        long.crossedThreshold = true;
        await Logger.log(`long crossedThreshold crossed price:${price} threshold:${long.threshold}`);
    }
    if (short.threshold > 0 && price < short.threshold && !short.crossedThreshold && side === 'Sell') {
        short.crossedThreshold = true;
        await Logger.log(`short crossedThreshold crossed price:${price} threshold:${long.threshold}`);
    }

    if (long.threshold > 0 && price > long.threshold && short.strikePrice !== long.breakEvenPrice) {
        await Logger.log(`short strike price reset as long price:${price} crossed threshold:${long.threshold} set to breakeven price:${long.breakEvenPrice}`);
        short.strikePrice = long.breakEvenPrice;
    }
    if (short.threshold > 0 && price < short.threshold && long.strikePrice !== short.breakEvenPrice) {
        await Logger.log(`long strike price reset as short price:${price} crossed threshold:${short.threshold} set to breakeven price:${short.breakEvenPrice}`);
        long.strikePrice = short.breakEvenPrice;
    }

    if (price < settings.longStrikePrice && price > settings.shortStrikePrice && noPosition) {
        await Logger.log(`resetting long and short strikePrice, breakEvenPrice and threshold as ${price} > ${settings.shortStrikePrice} and < ${settings.shortStrikePrice} and theres no position`);
        short.strikePrice = settings.shortStrikePrice;
        long.strikePrice = settings.longStrikePrice;
        long.breakEvenPrice = 0;
        long.threshold = 0;
        short.breakEvenPrice = 0;
        short.threshold = 0;
    }

    if ((long.breakEvenPrice === 0 || long.threshold === 0) && holdingLong) {
        long.breakEvenPrice = entryPrice + (entryPrice * 2 * commission);
        long.threshold = long.breakEvenPrice * (1 + settings.thresholdPercent);
        await Logger.log(`calculating long breakEvenPrice:${long.breakEvenPrice} and threshold:${long.threshold}`);
    }

    if ((short.breakEvenPrice === 0 || short.threshold === 0) && holdingShort) {
        short.breakEvenPrice = entryPrice - (entryPrice * 2 * commission);
        short.threshold = short.breakEvenPrice * (1 - settings.thresholdPercent);
        await Logger.log(`calculating short breakEvenPrice:${short.breakEvenPrice} and threshold:${short.threshold}`);
    }

    let mustSell = bid < short.strikePrice && !shortFilled;
    if (overbought) mustSell = true;

    if (mustSell && short.orderId && short.orderPrice !== price) {
        short.orderPrice = price;
        //update order
        let { retCode, retMsg } = await restClient.amendOrder({
            symbol: settings.symbol,
            category: 'linear',
            orderId: short.orderId,
            price: `${price}`
        });
        if (retCode === 110001 && retMsg === 'order not exists or too late to replace') {
            short.orderId = '';
            await Logger.log(`failed to update short orderId:${short.orderId}`);
        }
        else {
            await Logger.log(`ammend short order price:${price} symbol:${settings.symbol} orderId:${short.orderId}`);
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
    if (mustSell && holdingLong) {
        orderSize += size;
        state.bounceCount = bounceCount + 1;
    }
    if (mustSell && !holdingLong) state.bounceCount = 0;
    if (mustSell && long.crossedThreshold) reduceOnly = true;
    if (overbought) {
        orderSize = size - settings.size;
        reduceOnly = false;
    }
    if (mustSell && state.bounceCount <= settings.maxBounceCount) {
        let symbol = settings.symbol;
        short.orderPrice = price;
        let precision = precisionMap.get(symbol)?.sizePrecision || 3;
        let qty = `${round(orderSize, precision)}`;

        //create sell order
        let { result: order } = await restClient.submitOrder({
            category: 'linear',
            symbol,
            side: 'Sell',
            orderType: 'Limit',
            timeInForce: 'PostOnly',
            price: `${price}`,
            reduceOnly,
            qty
        });
        await Logger.log(`short sell order price:${price} qty:${qty} symbol:${symbol} orderId:${order.orderId}`);
        short.orderId = order.orderId;
        return;
    }

    let mustbuy = ask > long.strikePrice && !longFilled;
    if (oversold) mustbuy = true;

    orderSize = settings.size;
    reduceOnly = false
    if (mustbuy && long.orderId && long.orderPrice !== price) {
        long.orderPrice = price;

        //update order
        let { retCode, retMsg } = await restClient.amendOrder({
            symbol: settings.symbol,
            category: 'linear',
            orderId: long.orderId,
            price: `${price}`
        });
        if (retCode === 110001 && retMsg === 'order not exists or too late to replace') {
            long.orderId = '';
            await Logger.log(`failed to update long orderId:${long.orderId}`);
        }
        else {
            await Logger.log(`ammend long order price:${price} symbol:${settings.symbol} orderId:${long.orderId}`);
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

    if (mustbuy && holdingShort) {
        orderSize += size;
        state.bounceCount = bounceCount + 1;
    }
    if (mustbuy && !holdingShort) state.bounceCount = 0;
    if (mustbuy && short.crossedThreshold) reduceOnly = true;
    if (oversold) {
        orderSize = size - settings.size;
        reduceOnly = false;
    }
    if (mustbuy && state.bounceCount <= settings.maxBounceCount) {
        let symbol = settings.symbol;
        long.orderPrice = price;
        let precision = precisionMap.get(symbol)?.sizePrecision || 3;
        let qty = `${round(orderSize, precision)}`;

        //create buy order
        let { result: order } = await restClient.submitOrder({
            category: 'linear',
            symbol,
            side: 'Buy',
            orderType: 'Limit',
            timeInForce: 'PostOnly',
            price: `${price}`,
            reduceOnly,
            qty
        });
        await Logger.log(`long buy order price:${price} qty:${qty} symbol:${symbol} orderId:${order.orderId}`);
        long.orderId = order.orderId;
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
        bid: 0,
        ask: 0,
        size: 0,
        bounceCount: 0,
        long: {
            breakEvenPrice: 0,
            crossedThreshold: false,
            orderId: '',
            orderPrice: 0,
            strikePrice: settings.longStrikePrice,
            threshold: 0
        },
        short: {
            breakEvenPrice: 0,
            crossedThreshold: false,
            orderId: '',
            orderPrice: 0,
            strikePrice: settings.shortStrikePrice,
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

    orders = orders?.filter(o => !o.triggerPrice)
    for (let i = 0; i < orders.length || 0; i++) {
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