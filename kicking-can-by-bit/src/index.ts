import { setTimeout as asyncSleep } from 'timers/promises';
import { AccountTypeV5, RestClientV5, WebsocketClient } from 'bybit-api'
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import dotenv from 'dotenv';
import { round } from './calculations.js';
import { Logger } from './logger.js';
import { get } from 'http';

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
    reduceOnly: boolean
    fee: number
}

type State = {
    bid: number
    ask: number
    price: number
    symbol: string
    nextExpiry: Date
    nextSellSymbol: string
    nextSymbolMap: Map<string, string>
    options: Map<string, OptionPositon>
    orders: Map<string, Order>
    orderBooks: Map<string, OrderBook>
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
    accountType?: AccountTypeV5
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
    socketClient: WebsocketClient
}

function getNextSellSymbol({ currentSymbol, state, settings }: { currentSymbol: string, state: State, settings: Settings }): string | undefined {
    let offset = settings.stepSize * settings.stepOffset;
    let details = getSymbolDetails(currentSymbol);
    if (!details) return undefined;
    state.bounceCount = (state.bounceCount + 1) % settings.bounce;

    let { base, expiry, strikePrice, type } = details;
    let expiryString = getExpiryString(expiry.getTime());
    let shiftStrikePriceByOffset = state.bounceCount === 0;

    if (type === 'Call' && shiftStrikePriceByOffset) return `${base}-${expiryString}-${strikePrice + offset}-C`;
    if (type === 'Call' && !shiftStrikePriceByOffset) return `${base}-${expiryString}-${strikePrice - offset}-P`;
    if (type === 'Put' && shiftStrikePriceByOffset) return `${base}-${expiryString}-${strikePrice - offset}-P`;
    if (type === 'Put' && !shiftStrikePriceByOffset) return `${base}-${expiryString}-${strikePrice + offset}-C`;
}

async function getFirstSellSymbol({ symbol, expiry, restClient, settings }: { symbol: string, expiry: Date, restClient: RestClientV5, settings: Settings }): Promise<string> {
    let { retCode, retMsg, result } = await restClient.getOrderbook({ symbol, category: 'linear' });
    if (retCode !== 0 || !result || !result.b || result.b.length === 0 || !result.b[0] || !result.a || result.a.length === 0 || !result.a[0]) {
        throw `error getting orderbook for:${symbol} retCode:${retCode} retMsg:${retMsg}`;
    }

    let price = (parseFloat(result.b[0][0]) + parseFloat(result.a[0][0])) / 2;
    let strikePrice = round(price / settings.stepSize, 0) * settings.stepSize;
    let offset = settings.stepSize * settings.stepOffset;
    let priceIsBelowStrike = price < strikePrice;
    let expiryString = getExpiryString(expiry.getTime());

    if (priceIsBelowStrike) return `${settings.base}-${expiryString}-${strikePrice + offset}-C`;
    return `${settings.base}-${expiryString}-${strikePrice - offset}-P`;
}

function orderbookUpdate(data: any, state: State) {
    if (!data || !data.data || !data.data.b || !data.data.a) return;
    let topicParts = data.topic.split('.');
    if (!topicParts || topicParts.length !== 3) return;
    let precision = precisionMap.get(state.symbol)?.pricePrecision || 2;
    let ob = data.data;
    let symbol = topicParts[2];
    if (symbol === state.symbol) {
        if (ob.b.length > 0 && ob.b[0].length > 0) state.bid = parseFloat(ob.b[0][0]);
        if (ob.a.length > 0 && ob.a[0].length > 0) state.ask = parseFloat(ob.a[0][0]);

        state.price = round((state.bid + state.ask) / 2, precision);
        return;
    }
    let optionOb: OrderBook = {
        symbol,
        ask: (ob.a.length > 0 && ob.a[0].length > 0) ? parseFloat(ob.a[0][0]) : undefined,
        bid: (ob.b.length > 0 && ob.b[0].length > 0) ? parseFloat(ob.b[0][0]) : undefined
    }
    if (optionOb.ask !== undefined && optionOb.bid !== undefined) optionOb.price = round((optionOb.bid + optionOb.ask) / 2, precision);
    state.orderBooks.set(symbol, optionOb);
}

function orderUpdate(data: any, state: State) {
    if (!data || !data.data || data.data.length < 0 || !data.data[0]) return;
    let orderData = data.data[0];
    if (orderData.stopOrderType !== '') return;
    if (orderData.category !== 'option') return;

    let symbol = orderData.symbol;
    let details = getSymbolDetails(symbol);
    if (!details) return;

    let strikePrice = details.strikePrice;
    let side = orderData.side;
    let size = parseFloat(orderData.qty);
    let price = parseFloat(orderData.price);
    let value = size * price;
    let fee = strikePrice * commission * size;

    let orderId = orderData.orderId;
    let orderStatus = orderData.orderStatus;
    let reduceOnly = orderData.reduceOnly;

    switch (orderStatus) {
        case 'Cancelled':
        case 'Rejected':
        case 'Deactivated':
            state.orders.delete(orderId);
            break;
        case 'Filled':
            if (side === 'Buy') state.dailyBalance -= value + fee;
            if (side === 'Sell') state.dailyBalance += value - fee;
            state.orders.delete(orderId);
            break;
        case 'New':
            let order: Order = {
                id: orderId,
                symbol,
                size,
                side,
                fee,
                price,
                reduceOnly
            }
            state.orders.set(orderId, order);
            break;
    }
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
            case 'order':
                orderUpdate(data, state);
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

async function buyBackOptions({ options, state, settings, restClient, socketClient }: { options: OptionPositon[]; state: State; settings: Settings; restClient: RestClientV5; socketClient: WebsocketClient }): Promise<void> {
    let pricePrecision = precisionMap.get(`${settings.base}OPT`)?.pricePrecision || 2;
    let sizePrecision = precisionMap.get(`${settings.base}OPT`)?.sizePrecision || 1;
    let smallestPriceValue = Number(`1e-${pricePrecision}`);

    for (let option of options) {
        let size = option.size;
        if (size <= 0) continue;

        let symbol = option.symbol;
        let strikePrice = option.strikePrice;
        let orders = [...state.orders.values()].filter(o => o.symbol === symbol);
        let positionITM = option.type === 'Call' ? state.ask >= strikePrice : state.bid <= strikePrice;

        if (!positionITM && orders.length === 0) continue;
        if (!positionITM && orders.length > 0) {
            for (let i = 0; i < orders.length; i++) {
                let order = orders[i];
                let { retCode, retMsg } = await restClient.cancelOrder({ orderId: order.id, symbol: order.symbol, category: 'option' });
                if (retCode === 0) continue;
                await Logger.log(`error cancelling order: ${order.id} ${order.symbol} retCode:${retCode} retMsg:${retMsg}`);
            }
            continue;
        }

        let buyBackBid = state.orderBooks.get(symbol)?.bid;
        let buyBackAsk = state.orderBooks.get(symbol)?.ask;

        if (buyBackAsk === undefined) {
            await Logger.log(`cant buy back: ${symbol} as no ask price in orderbook`);
            continue;
        }
        let adjustedBuyBackPrice = (buyBackBid === undefined)
            ? round(buyBackAsk - smallestPriceValue, pricePrecision)
            : round(buyBackBid + smallestPriceValue, pricePrecision);

        if (positionITM && orders.length > 0) {
            for (let i = 0; i < orders.length; i++) {
                let order = orders[i];
                if (order.price === buyBackBid) continue;

                let { retCode, retMsg } = await restClient.amendOrder({
                    orderId: order.id,
                    price: `${adjustedBuyBackPrice}`,
                    symbol: order.symbol,
                    category: 'option'
                });
                if (retCode === 0) continue;

                await Logger.log(`error amending order: ${order.id} ${order.symbol} price:${adjustedBuyBackPrice} retCode:${retCode} retMsg:${retMsg}`);
            }
            continue;
        }

        let counterSymbol = state.nextSymbolMap.get(symbol);
        if (counterSymbol === undefined) {
            counterSymbol = getNextSellSymbol({ currentSymbol: symbol, state, settings });
            if (counterSymbol === undefined) {
                await Logger.log(`cant buy back: ${symbol} as there is no nextSymbol`);
                continue;
            }
            state.nextSymbolMap.set(symbol, counterSymbol);
            subscribeToOrderBookOptions({ optionSymbols: [counterSymbol], socketClient });
            continue;
        }

        let counterBid = state.orderBooks.get(counterSymbol)?.bid;
        if (counterBid === undefined) {
            await Logger.log(`cant buy back: ${symbol} as there is no counter order for ${counterSymbol} in orderbook`);
            continue;
        }

        let buyBackCost = (adjustedBuyBackPrice * size) + (strikePrice * size * commission);
        let targetProfit = settings.targetProfit - (state.dailyBalance - buyBackCost);
        let counterProfit = counterBid - (option.strikePrice * commission);
        let { strikePrice: counterStrikePrice } = (getSymbolDetails(counterSymbol) || { strikePrice });
        let counterSize = round(targetProfit / counterProfit, sizePrecision);
        let counterNotionalValue = counterSize * counterStrikePrice;

        if (counterNotionalValue > settings.maxNotionalValue) {
            Logger.log(`cant buy back option ${symbol} as notionalValue: ${counterNotionalValue} exceeds maxNotionalValue: ${settings.maxNotionalValue} for option: ${counterSymbol}`);
            continue;
        }

        let qty = `${round(option.size, sizePrecision)}`;
        let { retCode, retMsg } = await restClient.submitOrder({
            symbol,
            side: 'Buy',
            orderType: 'Limit',
            timeInForce: 'GTC',
            qty,
            price: `${adjustedBuyBackPrice}`,
            category: 'option',
            reduceOnly: true
        });

        if (retCode !== 0) {
            await Logger.log(`error buying back option: ${symbol} qty:${qty} price:${adjustedBuyBackPrice} retCode:${retCode} retMsg:${retMsg}`);
            continue
        }

        let nextSellSymbol = state.nextSymbolMap.get(symbol);
        if (nextSellSymbol === undefined) {
            nextSellSymbol = getNextSellSymbol({ currentSymbol: symbol, state, settings });
            if (nextSellSymbol === undefined) continue;
            state.nextSymbolMap.set(symbol, nextSellSymbol);
            subscribeToOrderBookOptions({ optionSymbols: [nextSellSymbol], socketClient });
        }
        state.nextSellSymbol = nextSellSymbol;
    }
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
    if (size <= 0) return;
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
        // state.options.push({
        //     id: (new Date()).getTime(),
        //     symbol,
        //     size: size,
        //     strikePrice,
        //     expiry: nextExpiry,
        //     entryPrice: bidPrice,
        //     type: 'Put'
        // });
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
    if (size <= 0) return;
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
        // state.options.push({
        //     id: (new Date()).getTime(),
        //     symbol,
        //     size: size,
        //     strikePrice,
        //     expiry: nextExpiry,
        //     entryPrice: bidPrice,
        //     type: 'Call'
        // });
    } else {
        await Logger.log(`error selling call option: ${symbol} retCode:${retCode} retMsg:${retMsg}`);
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
    let { bid, ask, price } = state;

    let nextExpiry = getNextExpiry();
    let nextTime = nextExpiry.getTime();

    if (nextTime !== state.nextExpiry.getTime()) {
        state.nextExpiry = nextExpiry;
        state.dailyBalance = 0;
        [...state.options.keys()].forEach(k => (state.options.get(k) || { expiry: new Date(nextTime) })?.expiry.getTime() < nextTime && state.options.delete(k));
        return;
    }

    let upperStrikePrice: number | undefined = undefined;
    let lowerStrikePrice: number | undefined = undefined;
    let nextOptions = [...state.options.values()].filter(o => o.expiry.getTime() === nextTime);

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

function getOrderBookSymbols({ positions, settings, state }: { positions: OptionPositon[]; settings: Settings; state: State }): string[] {
    let symbols: string[] = [];

    for (let i = 0; i < positions.length; i++) {
        let position = positions[i];

        symbols.push(position.symbol);

        let nextSellSymbol = getNextSellSymbol({ currentSymbol: position.symbol, state, settings });
        if (nextSellSymbol === undefined) continue;

        state.nextSymbolMap.set(position.symbol, nextSellSymbol);
        symbols.push(nextSellSymbol);
    }

    return symbols;
}

async function subscribeToOrderBookOptions({ optionSymbols, socketClient }: { optionSymbols: string[]; socketClient: WebsocketClient; }) {
    for (let i = 0; i < optionSymbols.length; i++) {
        let symbol = optionSymbols[i];
        await socketClient.subscribeV5(`orderbook.25.${symbol}`, 'option');
    }
}

async function getOrders({ restClient, settings }: { restClient: RestClientV5, settings: Settings }): Promise<Map<string, Order>> {
    let orders: Map<string, Order> = new Map();
    let cursor: string | undefined = undefined;

    while (true) {
        let { retCode, retMsg, result: { list, nextPageCursor } } = await restClient.getActiveOrders({
            baseCoin: settings.base,
            category: 'option',
            cursor
        });

        if (retCode !== 0) {
            Logger.log(`getting the orders failed for ${settings.base} ${retMsg}`);
            return orders;
        }

        for (let i = 0; i < list.length; i++) {
            let order = list[i];
            if (['New', 'Created', 'Active'].indexOf(order.orderStatus) === -1) continue;

            let qty = parseFloat(order.qty);
            let price = parseFloat(order.price);
            let details = getSymbolDetails(order.symbol);
            if (!details) continue;

            let strikePrice = details.strikePrice;
            let fee = strikePrice * commission * qty;

            orders.set(order.orderId, {
                id: order.orderId,
                symbol: order.symbol,
                size: qty,
                side: order.side,
                price,
                reduceOnly: order.reduceOnly,
                fee
            });
        }

        if (!(nextPageCursor as string)) break;
        cursor = nextPageCursor as string;
    }
    return orders;
}

async function getRunningBalance({ restClient, settings }: { restClient: RestClientV5, settings: Settings }): Promise<number> {
    let balance = 0;
    let nextExpiry = getNextExpiry();
    let startTime = nextExpiry.getTime() - (24 * 60 * 60 * 1000);//1 day
    let endTime = (new Date()).getTime();
    let accountType = settings.accountType || 'UNIFIED';
    let cursor: string | undefined = undefined;

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
            return 0;
        }

        for (let i = 0; i < list.length; i++) {
            let transactionLog = list[i];
            if (transactionLog.type !== 'TRADE') continue;

            let qty = parseFloat(transactionLog.qty);
            let price = parseFloat(transactionLog.tradePrice);
            let fee = parseFloat(transactionLog.fee);
            let tradeValue = qty * price;
            if (transactionLog.side === 'Sell') balance += tradeValue - fee;
            if (transactionLog.side === 'Buy') balance -= tradeValue + fee;
        }

        if (!(nextPageCursor as string)) break;
        cursor = nextPageCursor as string;
    }
    return balance;
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
    let dailyBalance = await getRunningBalance({ restClient, settings });
    let symbol = `${settings.base}${settings.quote}`;
    let nextSellSymbol = await getFirstSellSymbol({ symbol, expiry: nextExpiry, restClient, settings });
    let orders = await getOrders({ restClient, settings });

    let state: State = {
        symbol,
        nextExpiry,
        dailyBalance,
        nextSellSymbol,
        nextSymbolMap: new Map<string, string>(),
        options,
        bid: 0,
        ask: 0,
        price: 0,
        bounceCount: 0,
        orders,
        orderBooks: new Map<string, OrderBook>()
    } as State;

    socketClient.on('update', websocketCallback(state));

    await socketClient.subscribeV5(`orderbook.1.${state.symbol}`, 'linear');
    await socketClient.subscribeV5('order', 'option');
    await socketClient.subscribeV5('position', 'option');

    let optionSymbols = getOrderBookSymbols({ positions: [...options.values()], settings, state });
    optionSymbols.push(nextSellSymbol);
    await subscribeToOrderBookOptions({ optionSymbols, socketClient });

    await Logger.log(`state: ${JSON.stringify(state)}`);
    await Logger.log(`settings: ${JSON.stringify(settings)}`);

    let context: Context = {
        state,
        settings,
        restClient,
        socketClient
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



