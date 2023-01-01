import { setTimeout as asyncSleep } from 'timers/promises';
import { SpotClientV3, WebsocketClient } from "bybit-api";
import AWS from 'aws-sdk';
import dotenv from "dotenv";

type Position = { free: number, loan: number, tokenId: string };

dotenv.config({ override: true });

const
    months = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"],
    minSizes: { [id: string]: number } = {
        ETH: 0.08,
        NEAR: 1,
        USDT: 10,
        USDC: 10
    },
    credentialsKey = `${process.env.BYBIT_API_CREDENTIALS}`,
    settingsKey = `${process.env.BYBIT_SETTINGS}`,
    region = `${process.env.BYBIT_REGION}`;

let
    slippage: number = 0,
    symbol: string = '',
    baseCurrency: string = '',
    quoteCurrency: string = '',
    targetROI: number = 0,
    tradeMargin: number = 0,
    quotePrecision: number = 0,
    basePrecision: number = 0,
    logFrequency: number = 0,
    useTestnet: boolean = false,
    leverage: number = 0;

let
    initialEquity: number = 0,
    sessionEquity: number = 0,
    strikePrice: number = 0,
    size: number = 0,
    client: SpotClientV3,
    wsSpot: WebsocketClient | null = null,
    positionsNeedUpdate: boolean = false,
    basePosition: Position,
    quotePosition: Position,
    bidPrice: number = 0,
    askPrice: number = 0,
    logCount: number = 0,
    ssm: AWS.SSM | null = null;

function floor(num: number, precision: number = quotePrecision) {
    let exp = Math.pow(10, precision);
    return Math.floor((+num * exp)) / exp;
}

async function immediateSell(symbol: string, orderQty: number, price: number, coin: string = baseCurrency) {
    orderQty = floor(orderQty, basePrecision);
    if (orderQty <= (minSizes[coin] || 0)) return;
    positionsNeedUpdate = true;

    while (true) {
        price = floor(price, quotePrecision)
        log(`immediate sell qty: ${orderQty} at ${price}`);

        let orderResponse = await client.submitOrder({
            orderType: "LIMIT",
            orderQty: `${orderQty}`,
            orderPrice: `${price}`,
            side: "Sell",
            symbol: symbol,
            timeInForce: "IOC"
        });

        if (orderResponse.retCode == 12229) {
            await logError(orderResponse.retMsg);
            orderQty = await getSellableAmount(coin, orderQty);
            orderQty = floor(orderQty, basePrecision);
            ({ result: { price } } = await client.getLastTradedPrice(symbol));
            if (orderQty > 0) continue;
            return;
        }

        if (orderResponse.retCode == 0) return;

        await logError(orderResponse.retMsg);
        return;
    }
}

async function immediateBuy(symbol: string, orderQty: number, price: number, quoteCoin: string = quoteCurrency) {
    orderQty = floor(orderQty, basePrecision);
    if (orderQty <= ((minSizes[quoteCurrency] || 0) / price)) return;
    positionsNeedUpdate = true;

    while (true) {
        price = floor(price, quotePrecision)
        log(`immediate buy qty: ${orderQty} at ${price}`);

        let orderResponse = await client.submitOrder({
            orderType: "LIMIT",
            orderQty: `${orderQty}`,
            orderPrice: `${price}`,
            side: "Buy",
            symbol: symbol,
            timeInForce: "IOC"
        });

        if (orderResponse.retCode == 12228) {
            await logError(orderResponse.retMsg);
            await borrowIfRequired(quoteCoin, orderQty * price, quotePrecision);
            ({ result: { price } } = await client.getLastTradedPrice(symbol));
            continue;
        }

        if (orderResponse.retCode == 0) return;

        await logError(orderResponse.retMsg);
        return;
    }
}

async function borrowIfRequired(coin: string, quantity: number, precision: number = quotePrecision) {
    let response = await client.getCrossMarginAccountInfo();
    if (response.retCode != 0) {
        await logError(`borrowIfRequired ${response.retMsg}`);
        return;
    }

    let { result: { loanAccountList } } = response;
    let position = getPosition(loanAccountList, coin, precision);
    log(`borrowIfRequired free:${position.free} quantity: ${quantity}`)
    if (position.free >= quantity) return;

    let diff = floor(quantity - position.free, precision);
    if (diff == 0) return;
    positionsNeedUpdate = true;
    await borrowFunds(coin, diff);
}

async function getSellableAmount(coin: string, quantity: number): Promise<number> {
    let response = await client.getCrossMarginAccountInfo();
    if (response.retCode != 0) {
        await logError(`getSellableAmount ${response.retMsg}`);
        return quantity;
    }
    let { result: { loanAccountList } } = response;
    let position = getPosition(loanAccountList, coin, basePrecision);
    return Math.min(quantity, position.free);
}

async function borrowFunds(coin: string, quantity: number) {
    if (!!minSizes[coin] && quantity < minSizes[coin]) quantity = minSizes[coin];
    log(`borrow ${coin} ${quantity}`);
    positionsNeedUpdate = true;
    let borrowResponse = await client.borrowCrossMarginLoan(coin, `${quantity}`);

    if (borrowResponse.retCode == 0) return;
    await logError(`borrowFunds ${borrowResponse.retMsg}`);
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

function calculateNetEquity(basePosition: Position, quotePosition: Position, price: number): number {
    let qouteTotal = quotePosition.free - quotePosition.loan;
    let baseTotal = (basePosition.free - basePosition.loan) * price;
    return floor(qouteTotal + baseTotal, quotePrecision);
}

async function settleAccount(position: Position, price: number) {
    log(`Settling account free: ${position.free} loan: ${position.loan} price: ${price}`);
    positionsNeedUpdate = true;
    if (position.free < position.loan) {
        let buyAmount = floor(position.loan - position.free, basePrecision);
        let buyPrice = floor(price * (1 + slippage), quotePrecision);
        await immediateBuy(symbol, buyAmount, buyPrice);
    }
    if (position.free > position.loan) {
        let sellAmount = floor(position.free - position.loan, basePrecision);;
        let sellPrice = floor(price * (1 - slippage), quotePrecision);
        await immediateSell(symbol, sellAmount, sellPrice);
    }
}

function getPosition(loanAccountList: Position[], tokenId: string, precision: number): Position {
    let position = (<Position[]>loanAccountList).find(item => item.tokenId == tokenId) || { free: 0, loan: 0, tokenId };
    position.free = floor(position.free, precision);
    position.loan = floor(position.loan, precision);
    return position;
}

async function getPositions(): Promise<{ basePosition: Position, quotePosition: Position }> {
    let { result: { loanAccountList } } = await client.getCrossMarginAccountInfo();
    let basePosition = getPosition(loanAccountList, baseCurrency, basePrecision);
    let quotePosition = getPosition(loanAccountList, quoteCurrency, basePrecision);
    return { basePosition, quotePosition };
}

async function reconcileLoan(basePosition: Position, quantity: number, price: number) {
    if (basePosition.loan == quantity) return;
    positionsNeedUpdate = true;

    if (basePosition.loan < quantity) {
        let borrowAmount = floor(quantity - basePosition.loan, basePrecision);
        await borrowFunds(baseCurrency, borrowAmount);
        return;
    }

    let repayment = floor(basePosition.loan - quantity, basePrecision);
    if (repayment == 0) return;
    if (repayment > basePosition.free) {
        let buyAmount = repayment - basePosition.free;
        let buyPrice = floor(price * (1 + slippage), quotePrecision);
        await immediateBuy(symbol, buyAmount, buyPrice);
    }

    while (true) {
        let { retCode, retMsg } = await client.repayCrossMarginLoan(baseCurrency, `${repayment}`);
        if (retCode == 0 || retCode == 12000) return;
        logError(`couldn't reconcile loan:${basePosition.loan} free:${basePosition.free} quantity:${quantity} repayment:${repayment} (${retCode}) ${retMsg}`);
    }
}

async function executeTrade({
    size,
    basePosition,
    quotePosition,
    initialEquity,
    sessionEquity,
    strikePrice,
    askPrice,
    bidPrice
}: {
    size: number,
    basePosition: Position,
    quotePosition: Position,
    initialEquity: number,
    sessionEquity: number,
    strikePrice: number,
    askPrice: number,
    bidPrice: number
}): Promise<{
    strikePrice: number,
    sessionEquity: number
}> {
    if (strikePrice == 0) strikePrice = (bidPrice + askPrice) / 2;
    if (sessionEquity == 0) sessionEquity = initialEquity;

    let price = (basePosition.free > 0) ? bidPrice : askPrice;
    let netEquity = calculateNetEquity(basePosition, quotePosition, price);
    let targetProfit = initialEquity * (1 + targetROI);
    let sessionProfit = netEquity - sessionEquity - targetProfit;

    if ((logCount % logFrequency) == 0) {
        log(`f:${basePosition.free} l:${basePosition.loan} ap:${askPrice} bp:${bidPrice} sp:${strikePrice} q:${size} ne:${netEquity} se:${sessionEquity} ie:${initialEquity} tp:${targetProfit} gp:${netEquity - initialEquity} sgp:${netEquity - sessionEquity}`);
        logCount = 1;
    }
    else logCount++;

    if ((askPrice > strikePrice && bidPrice < strikePrice) ||
        (sessionProfit > 0)) {
        settleAccount(basePosition, bidPrice);
        sessionEquity = netEquity;
        strikePrice = (bidPrice + askPrice) / 2;
        log(`settle f:${basePosition.free} l:${basePosition.loan} ap:${askPrice} bp:${bidPrice} sp:${strikePrice} q:${size} ne:${netEquity} se:${sessionEquity} ie:${initialEquity} tp:${targetProfit} gp:${netEquity - initialEquity} sgp:${netEquity - sessionEquity} ssp:${sessionProfit}`);
        return { sessionEquity, strikePrice };
    }

    let netBasePosition = floor(basePosition.free - basePosition.loan, basePrecision);
    let longAmount = floor(size - netBasePosition, basePrecision);
    if (bidPrice > strikePrice && longAmount > 0.001) {
        let buyPrice = floor(strikePrice * (1 + slippage), quotePrecision);
        await immediateBuy(symbol, longAmount, buyPrice);
        log(`long f:${basePosition.free} l:${basePosition.loan} ap:${askPrice} bp:${bidPrice} sp:${strikePrice} q:${size} ne:${netEquity} se:${sessionEquity} ie:${initialEquity} tp:${targetProfit} gp:${netEquity - initialEquity} sgp:${netEquity - sessionEquity}`);
        return { sessionEquity, strikePrice };
    }

    if (askPrice < strikePrice && basePosition.free > 0) {
        let sellAmount = floor(basePosition.free, basePrecision);
        let sellPrice = floor(strikePrice * (1 - slippage), quotePrecision);
        await immediateSell(symbol, sellAmount, sellPrice);
        log(`short f:${basePosition.free} l:${basePosition.loan} ap:${askPrice} bp:${bidPrice} sp:${strikePrice} q:${size} ne:${netEquity} se:${sessionEquity} ie:${initialEquity} tp:${targetProfit} gp:${netEquity - initialEquity} sgp:${netEquity - sessionEquity}`);
    }

    return { sessionEquity, strikePrice };
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
    slippage, baseCurrency, quoteCurrency, leverage,
    tradeMargin, quotePrecision, basePrecision, logFrequency, useTestnet
} = JSON.parse(`${settingsParameter.Parameter?.Value}`));

symbol = `${baseCurrency}${quoteCurrency}`;

while (true) {

    try {
        client = new SpotClientV3({
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
            if (data?.topic == 'outboundAccountInfo') positionsNeedUpdate = true;
            if (data?.topic == `bookticker.${symbol}` && data.data?.ap && data.data?.bp) {
                bidPrice = floor(data.data?.bp, quotePrecision);
                askPrice = floor(data.data?.ap, quotePrecision);
            }
        });

        wsSpot.subscribe(['outboundAccountInfo', `bookticker.${symbol}`]);
        ({ basePosition, quotePosition } = await getPositions());

        while (true) {
            var { result: { price: p }, retCode, retMsg } = await client.getLastTradedPrice(symbol);
            bidPrice = floor(p, quotePrecision);
            if (isNaN(bidPrice)) continue;
            if (retCode == 0) break;
            logError(`Failed getting price (${retCode}) ${retMsg}`)
        }

        initialEquity = calculateNetEquity(basePosition, quotePosition, bidPrice);

        while (true) {
            await asyncSleep(100);

            if (size == 0) {
                let tradableEquity = initialEquity * tradeMargin;

                size = floor((tradableEquity * leverage) / bidPrice, basePrecision);
                await reconcileLoan(basePosition, size, bidPrice);
                positionsNeedUpdate = true;
            }

            if (positionsNeedUpdate) {
                ({ basePosition, quotePosition } = await getPositions());
                positionsNeedUpdate = false;
            }

            ({ sessionEquity, strikePrice } = await executeTrade({ askPrice, basePosition, bidPrice, initialEquity, size, quotePosition, strikePrice, sessionEquity }));
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