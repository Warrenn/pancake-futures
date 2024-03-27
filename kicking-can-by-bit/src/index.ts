import { setTimeout as asyncSleep } from 'timers/promises';
import { AccountTypeV5, RestClientV5, WebsocketClient } from 'bybit-api'
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import dotenv from 'dotenv';
import { round } from './calculations.js';
import { Logger } from './logger.js';

const commission = 0.0002;
const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const precisionMap = new Map<string, SymbolPrecision>()
precisionMap.set('ETHPERP', { pricePrecision: 2, sizePrecision: 3 });
precisionMap.set('ETHUSDT', { pricePrecision: 2, sizePrecision: 3 });
precisionMap.set('ETHOPT', { pricePrecision: 1, sizePrecision: 1 });

type OptionPositon = {
    symbol: string
    size: number
    expiry: Date
    strikePrice: number
    entryPrice: number
    type: 'Put' | 'Call'
}

type OrderBook = {
    symbol: string
    bid?: number
    ask?: number
    price?: number
}

type Order = {
    id: string
    symbol: string
    size: number
    side: 'Buy' | 'Sell'
    price: number
    strikePrice: number
    reduceOnly: boolean
    fee: number
    type: 'Put' | 'Call'
    expiry: Date
}

type State = {
    bid: number
    ask: number
    price: number
    symbol: string
    nextExpiry: Date
    options: Map<string, OptionPositon>
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
    accountType?: AccountTypeV5
    stepSize: number
    shiftSize: number
    base: string
    quote: string
    targetProfit: number
    maxSize: number
}

type Context = {
    state: State
    settings: Settings
    restClient: RestClientV5
    getSettings: () => Promise<Settings>
}

function orderbookUpdate(data: any, state: State) {
    if (!data || !data.data || !data.data.b || !data.data.a) return;
    let topicParts = data.topic.split('.');
    if (!topicParts || topicParts.length !== 3) return;
    let precision = precisionMap.get(state.symbol)?.pricePrecision || 2;
    let ob = data.data;
    let symbol = topicParts[2];
    if (symbol !== state.symbol) return;
    if (ob.b.length > 0 && ob.b[0].length > 0) state.bid = parseFloat(ob.b[0][0]);
    if (ob.a.length > 0 && ob.a[0].length > 0) state.ask = parseFloat(ob.a[0][0]);

    state.price = round((state.bid + state.ask) / 2, precision);
}

function positionUpdate(data: any, state: State) {
    if (!data || !data.data || data.data.length < 0 || !data.data[0]) return;

    let positionData = data.data[0];
    let size = Math.abs(parseFloat(positionData.size));
    let entryPrice = parseFloat(positionData.entryPrice);
    let symbol = positionData.symbol;
    let details = getSymbolDetails(symbol);

    if (!details) return;
    let { expiry, strikePrice, type } = details;
    let position: OptionPositon = {
        symbol,
        size,
        expiry,
        strikePrice,
        entryPrice,
        type
    }
    state.options.set(symbol, position);
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
            case 'position':
                positionUpdate(data, state);
                break;
        }
    }
}

async function getOrderBook({ symbol, restClient, settings }: { symbol: string; restClient: RestClientV5, settings: Settings }): Promise<OrderBook> {
    let pricePrecision = precisionMap.get(`${settings.base}OPT`)?.pricePrecision || 1;
    let { retCode, retMsg, result } = await restClient.getOrderbook({ symbol, category: 'option' });
    if (retCode !== 0) {
        await Logger.log(`error getting orderbook for ${symbol} retCode:${retCode} retMsg:${retMsg}`);
        return { symbol };
    }

    let bid: number | undefined = (result?.b?.length > 0 && result.b[0].length > 0) ? parseFloat(result.b[0][0]) : undefined;
    let ask: number | undefined = (result?.a?.length > 0 && result.a[0].length > 0) ? parseFloat(result.a[0][0]) : undefined;
    let price = (bid !== undefined && ask !== undefined) ? round((bid + ask) / 2, pricePrecision) : undefined;

    let orderBook: OrderBook = {
        symbol,
        bid,
        ask,
        price
    };
    return orderBook;
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

async function buyBackOptions({ options, orders, state, settings, restClient }: { options: OptionPositon[]; orders: Order[]; state: State; settings: Settings; restClient: RestClientV5 }): Promise<void> {
    let price = state.price;
    if (price <= 0) return;
    let pricePrecision = precisionMap.get(`${settings.base}OPT`)?.pricePrecision || 1;
    let sizePrecision = precisionMap.get(`${settings.base}OPT`)?.sizePrecision || 1;
    let smallestPriceValue = Number(`1e-${pricePrecision}`);
    let expiry = state.nextExpiry;

    for (let i = 0; i < options.length; i++) {
        let option = options[i];
        let size = option.size;
        if (size <= 0) continue;


        let symbol = option.symbol;
        let { strikePrice, type } = option;

        let positionITM = type === 'Call' ? state.ask >= strikePrice : state.bid <= strikePrice;
        let buyOrders = orders.filter(o => o.side === 'Buy' && o.expiry.getTime() === expiry.getTime() && o.strikePrice === strikePrice && o.type === type);

        if (!positionITM && buyOrders.length === 0) continue;
        if (!positionITM && buyOrders.length > 0) {
            for (let i = 0; i < buyOrders.length; i++) {
                let order = buyOrders[i];
                let { retCode, retMsg } = await restClient.cancelOrder({ orderId: order.id, symbol: order.symbol, category: 'option' });
                if (retCode === 0) {
                    await Logger.log(`cancelled reduce only order: ${order.id} ${order.symbol} ask:${state.ask} bid:${state.bid} strikePrice:${strikePrice} type:${option.type}`);
                    continue;
                }
                await Logger.log(`error cancelling reduce only order: ${order.id} ${order.symbol} ask:${state.ask} bid:${state.bid} strikePrice:${strikePrice} type:${option.type} retCode:${retCode} retMsg:${retMsg}`);
            }
            continue;
        }

        let { bid: buyBackBid, ask: buyBackAsk } = await getOrderBook({ symbol, restClient, settings });;
        if (buyBackAsk === undefined) {
            await Logger.log(`cant buy back: ${symbol} as no ask price in orderbook`);
            continue;
        }
        let adjustedBuyBackPrice = (buyBackBid === undefined)
            ? round(buyBackAsk - smallestPriceValue, pricePrecision)
            : round(buyBackBid + smallestPriceValue, pricePrecision);

        if (positionITM && buyOrders.length > 0) {
            for (let i = 0; i < buyOrders.length; i++) {
                let order = buyOrders[i];
                if (buyBackBid !== undefined && order.price === buyBackBid) continue;

                let { retCode, retMsg } = await restClient.amendOrder({
                    orderId: order.id,
                    price: `${adjustedBuyBackPrice}`,
                    symbol: order.symbol,
                    category: 'option'
                });
                if (retCode === 0) continue;

                await Logger.log(`error amending buy order: ${order.id} ${order.symbol} price:${adjustedBuyBackPrice} retCode:${retCode} retMsg:${retMsg}`);
            }
            continue;
        }

        let qty = `${round(option.size, sizePrecision)}`;
        let { retCode, retMsg } = await restClient.submitOrder({
            symbol,
            side: 'Buy',
            orderLinkId: `${Date.now()}`,
            orderType: 'Limit',
            timeInForce: 'PostOnly',
            qty,
            price: `${adjustedBuyBackPrice}`,
            category: 'option',
            reduceOnly: true
        });

        if (retCode === 0) {
            await Logger.log(`buying back option: ${symbol} qty:${qty} price:${adjustedBuyBackPrice}`);
        } else {
            await Logger.log(`error buying back option: ${symbol} qty:${qty} price:${adjustedBuyBackPrice} retCode:${retCode} retMsg:${retMsg}`);
        }
    }
}


function getSymbolDetails(symbol: string): { base: string, expiry: Date; strikePrice: number; type: 'Put' | 'Call' } | undefined {
    let checkExpression = new RegExp(`^(\\w+)-(\\d+)(\\w{3})(\\d{2})-(\\d*)-(P|C)$`);
    let matches = symbol.match(checkExpression);
    if (!matches) return undefined;

    let base = matches[1];
    let strikePrice = parseFloat(matches[5]);
    let type: 'Put' | 'Call' = matches[6] === 'P' ? 'Put' : 'Call';
    let mIndex = months.indexOf(matches[3]);
    let expiry = new Date();
    let newYear = parseInt(`20${matches[4]}`);
    expiry.setUTCDate(parseInt(matches[2]));
    expiry.setUTCHours(8);
    expiry.setUTCMinutes(0);
    expiry.setUTCSeconds(0);
    expiry.setUTCMilliseconds(0);
    expiry.setUTCMonth(mIndex);
    expiry.setUTCFullYear(newYear);

    return { base, strikePrice, expiry, type };
}

async function getOptions({ restClient, settings }: { restClient: RestClientV5; settings: Settings }): Promise<Map<string, OptionPositon>> {
    let
        baseCurrency = settings.base,
        { result: { list } } = await restClient.getPositionInfo({ category: "option", baseCoin: baseCurrency }),
        options = new Map<string, OptionPositon>();

    for (let c = 0; c < (list || []).length; c++) {
        let optionPosition = list[c];
        let symbol = optionPosition.symbol;
        let details = getSymbolDetails(symbol);
        if (!details) continue;

        let { base, expiry, strikePrice, type } = details;
        if (base !== settings.base) continue;

        let position = {
            symbol,
            size: parseFloat(optionPosition.size),
            expiry,
            strikePrice,
            entryPrice: parseFloat(optionPosition.avgPrice),
            type
        };
        options.set(symbol, position);
    }

    return options;
}

async function tradingStrategy(context: Context) {
    let { state, settings, restClient } = context;

    let nextExpiry = getNextExpiry();
    let nextTime = nextExpiry.getTime();

    if (nextTime !== state.nextExpiry.getTime()) {
        context.settings = await context.getSettings();
        state.nextExpiry = nextExpiry;
        [...state.options.keys()].forEach(k => (state.options.get(k)?.expiry.getTime() || nextTime) < nextTime && state.options.delete(k));

        return;
    }

    let { callBalance, putBalance } = await getRunningBalance({ restClient, settings });
    let orders = await getOrders({ restClient, settings });
    let options = [...state.options.values()];
    await buyBackOptions({ options, orders, state, settings, restClient });

    let { potentialCallProfit, potentialPutProfit, potentialCallSize, potentialPutSize } = await updateSellOrders({ state, orders, restClient, settings });

    let targetProfit = settings.targetProfit - callBalance - putBalance - potentialCallProfit - potentialPutProfit;
    if (targetProfit <= 0) return;

    await Logger.log(`targetProfit: ${targetProfit} callBalance: ${callBalance} putBalance: ${putBalance} potentialCallProfit: ${potentialCallProfit} potentialPutProfit: ${potentialPutProfit}`);
    await sellRequiredOptions({ state, settings, restClient, callBalance, putBalance, potentialCallProfit, potentialPutProfit, potentialCallSize, potentialPutSize });
}

async function getOrders({ restClient, settings }: { restClient: RestClientV5, settings: Settings }): Promise<Order[]> {
    let orders: Order[] = [];
    let cursor: string | undefined = undefined;

    while (true) {
        let { retCode, retMsg, result: { list, nextPageCursor } } = await restClient.getActiveOrders({
            baseCoin: settings.base,
            category: 'option',
            cursor
        });

        if (retCode !== 0) {
            Logger.log(`getting the orders failed for ${settings.base} ${retMsg}`);
            return [];
        }

        for (let i = 0; i < list.length; i++) {
            let order = list[i];
            if (['New', 'Created', 'Active', 'PartiallyFilled'].indexOf(order.orderStatus) === -1) continue;

            let size = parseFloat(order.qty);
            let price = parseFloat(order.price);
            let details = getSymbolDetails(order.symbol);
            if (!details) continue;

            let { strikePrice, type, base, expiry } = details;
            if (base !== settings.base) continue;

            let fee = strikePrice * commission * size;

            orders.push({
                id: order.orderId,
                symbol: order.symbol,
                size,
                side: order.side,
                strikePrice,
                price,
                type,
                reduceOnly: order.reduceOnly,
                fee,
                expiry
            });
        }

        if (!(nextPageCursor as string)) break;
        cursor = nextPageCursor as string;
    }
    return orders;
}

async function sellRequiredOptions({ state, settings, restClient, callBalance, putBalance, potentialCallProfit, potentialPutProfit, potentialCallSize, potentialPutSize }: { state: State; settings: Settings; restClient: RestClientV5; callBalance: number; putBalance: number; potentialCallProfit: number; potentialPutProfit: number; potentialCallSize: number; potentialPutSize: number }) {
    let { nextExpiry, price } = state;
    let highestCall = 0;
    let lowestPut = Number.MAX_SAFE_INTEGER;
    let callSize = potentialCallSize;
    let putSize = potentialPutSize;

    for (let value of state.options.values()) {
        let { strikePrice, type, size } = value;
        if (type === 'Call' && strikePrice > highestCall) highestCall = strikePrice;
        if (type === 'Put' && strikePrice < lowestPut) lowestPut = strikePrice;
        if (type === 'Call') callSize += size;
        if (type === 'Put') putSize += size;
    }

    let strikePrice = Math.round(price / settings.stepSize) * settings.stepSize;
    let optionTargetSize = settings.targetProfit / 2;

    let callStrikePrice = (highestCall > 0) ? highestCall : strikePrice + (settings.stepSize * settings.shiftSize);
    let putStrikePrice = (lowestPut < Number.MAX_SAFE_INTEGER) ? lowestPut : strikePrice - (settings.stepSize * settings.shiftSize);

    let target = optionTargetSize - potentialCallProfit - callBalance;
    let symbol = `${settings.base}-${getExpiryString(nextExpiry.getTime())}-${callStrikePrice}-C`
    await placeSellOrder({ strikePrice: callStrikePrice, target, settings, restClient, symbol, existingSize: callSize });

    target = optionTargetSize - potentialPutProfit - putBalance;
    symbol = `${settings.base}-${getExpiryString(nextExpiry.getTime())}-${putStrikePrice}-P`
    await placeSellOrder({ strikePrice: putStrikePrice, target, settings, restClient, symbol, existingSize: putSize });
}

async function updateSellOrders({ orders, state, restClient, settings }: { orders: Order[], state: State, restClient: RestClientV5, settings: Settings }): Promise<{ potentialCallProfit: number, potentialPutProfit: number, potentialCallSize: number, potentialPutSize: number }> {
    let pricePrecision = precisionMap.get(`${settings.base}OPT`)?.pricePrecision || 1;
    let sizePrecision = precisionMap.get(`${settings.base}OPT`)?.sizePrecision || 1;
    let { nextExpiry, ask, bid } = state;
    let smallestPriceValue = Number(`1e-${pricePrecision}`);

    let potentialCallProfit = 0;
    let potentialPutProfit = 0;
    let potentialCallSize = 0;
    let potentialPutSize = 0;

    let sellOrders = orders.filter(o => o.side === 'Sell' && o.expiry.getTime() === nextExpiry.getTime());

    for (let i = 0; i < sellOrders.length; i++) {
        let order = sellOrders[i];

        if ((order.type === 'Call' && ask > order.strikePrice) ||
            (order.type === 'Put' && bid < order.strikePrice)) {
            let { retCode, retMsg } = await restClient.cancelOrder({ orderId: order.id, symbol: order.symbol, category: 'option' });
            if (retCode === 0) {
                await Logger.log(`ITM cancel sell order: ${order.id} ${order.symbol} ask:${ask} bid:${bid} strikePrice:${order.strikePrice} type:${order.type}`);
                continue;
            }
            await Logger.log(`error cancelling ITM sell order: ${order.id} ${order.symbol} retCode:${retCode} retMsg:${retMsg}`);
        }

        let symbol = order.symbol;
        let value = order.price * order.size;
        let profit = value - order.fee;

        let { ask: orderAsk } = await getOrderBook({ symbol, restClient, settings });
        if ((orderAsk === undefined || orderAsk === order.price) && order.type === 'Call') {
            potentialCallProfit += profit;
            potentialCallSize += order.size;
            continue;
        }
        if ((orderAsk === undefined || orderAsk === order.price) && order.type === 'Put') {
            potentialPutProfit += profit;
            potentialPutSize += order.size;
            continue;
        }
        if (orderAsk === undefined) continue;

        let adjustedOrderPrice = round(orderAsk - smallestPriceValue, pricePrecision);
        let qty = round(value / adjustedOrderPrice, sizePrecision);
        let fee = qty * order.strikePrice * commission;
        if (order.type === 'Call') {
            potentialCallProfit += (qty * adjustedOrderPrice - fee);
            potentialCallSize += qty;
        }
        if (order.type === 'Put') {
            potentialPutProfit += (qty * adjustedOrderPrice - fee);
            potentialPutSize += qty;
        }

        let { retCode, retMsg } = await restClient.amendOrder({
            orderId: order.id,
            price: `${adjustedOrderPrice}`,
            qty: `${qty}`,
            symbol: order.symbol,
            category: 'option'
        });
        if (retCode === 0) continue;
        await Logger.log(`error amending order: ${order.id} ${order.symbol} price:${adjustedOrderPrice} qty:${qty} retCode:${retCode} retMsg:${retMsg}`);
    }
    return { potentialCallProfit, potentialPutProfit, potentialCallSize, potentialPutSize };
}

async function placeSellOrder({ strikePrice, symbol, target, settings, restClient, existingSize }: { strikePrice: number; symbol: string; target: number; settings: Settings; restClient: RestClientV5; existingSize: number }) {
    if (target <= 0) return;

    let pricePrecision = precisionMap.get(`${settings.base}OPT`)?.pricePrecision || 1;
    let sizePrecision = precisionMap.get(`${settings.base}OPT`)?.sizePrecision || 1;
    let smallestPriceValue = Number(`1e-${pricePrecision}`);

    let { bid: sellBid, ask: sellAsk } = await getOrderBook({ symbol, restClient, settings });
    if (sellBid === undefined) {
        await Logger.log(`cant sell option ${symbol} as there is no bid price in orderbook`);
        return;
    };

    let adjustedSellPrice = (sellAsk === undefined) ?
        round(sellBid + smallestPriceValue, pricePrecision) :
        round(sellAsk - smallestPriceValue, pricePrecision);

    let sellProfit = adjustedSellPrice - (strikePrice * commission);
    let sellSize = round(target / sellProfit, sizePrecision);

    if (sellSize <= 0) return;
    if ((sellSize + existingSize) > settings.maxSize) return;

    let { retCode, retMsg } = await restClient.submitOrder({
        symbol,
        orderLinkId: `${Date.now()}`,
        side: 'Sell',
        orderType: 'Limit',
        timeInForce: 'PostOnly',
        qty: `${sellSize}`,
        price: `${adjustedSellPrice}`,
        category: 'option',
        reduceOnly: false
    });
    if (retCode === 0) {
        await Logger.log(`selling option: ${symbol} qty:${sellSize} price:${adjustedSellPrice}`);
        return;
    }

    await Logger.log(`error selling option: ${symbol} qty:${sellSize} price:${adjustedSellPrice} retCode:${retCode} retMsg:${retMsg}`);
}

async function getRunningBalance({ restClient, settings }: { restClient: RestClientV5, settings: Settings }): Promise<{ callBalance: number; putBalance: number; }> {
    let nextExpiry = getNextExpiry();
    let startTime = nextExpiry.getTime() - (24 * 60 * 60 * 1000);//1 day
    let endTime = (new Date()).getTime();
    let accountType = settings.accountType || 'UNIFIED';
    let cursor: string | undefined = undefined;
    let callBalance = 0;
    let putBalance = 0;

    while (true) {
        let { retCode, result: { list, nextPageCursor }, retMsg } = await restClient.getTransactionLog({
            accountType,
            baseCoin: settings.base,
            category: 'option',
            startTime,
            endTime,
            cursor
        })

        if (retCode !== 0) {
            Logger.log(`getting the transactions failed for ${settings.base} accountType: ${accountType} ${retMsg} setting default balance: 0`);
            return { putBalance: 0, callBalance: 0 };
        }

        for (let i = 0; i < list.length; i++) {
            let transactionLog = list[i];
            if (transactionLog.type !== 'TRADE') continue;
            let details = getSymbolDetails(transactionLog.symbol);
            if (!details || details.base != settings.base) continue;

            let qty = parseFloat(transactionLog.qty);
            let price = parseFloat(transactionLog.tradePrice);
            let fee = parseFloat(transactionLog.fee);
            let tradeValue = qty * price;

            if (details.type === 'Call' && transactionLog.side === 'Sell') callBalance += (tradeValue - fee);
            if (details.type === 'Call' && transactionLog.side === 'Buy') callBalance -= (tradeValue + fee);

            if (details.type === 'Put' && transactionLog.side === 'Sell') putBalance += (tradeValue - fee);
            if (details.type === 'Put' && transactionLog.side === 'Buy') putBalance -= (tradeValue + fee);
        }

        if (!(nextPageCursor as string)) break;
        cursor = nextPageCursor as string;
    }
    return { callBalance, putBalance };
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
    let nextExpiry = getNextExpiry();
    let symbol = `${settings.base}${settings.quote}`;

    let state: State = {
        symbol,
        nextExpiry,
        options,
        bid: 0,
        ask: 0,
        price: 0
    } as State;

    socketClient.on('update', websocketCallback(state));

    await socketClient.subscribeV5(`orderbook.1.${state.symbol}`, 'linear');
    await socketClient.subscribeV5('position', 'option');

    await Logger.log(`state: ${JSON.stringify(state)}`);
    await Logger.log(`settings: ${JSON.stringify(settings)}`);

    let context: Context = {
        state,
        settings,
        restClient,
        getSettings: async () => await getSettings({ ssm, name: 'settings', keyPrefix })
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