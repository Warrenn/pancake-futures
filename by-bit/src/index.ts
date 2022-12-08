import { setTimeout as asyncSleep } from 'timers/promises';
import { SpotClientV3, AccountAssetClient, USDCOptionClient, UnifiedMarginClient } from "bybit-api";
import { appendFile, writeFile } from 'fs/promises';
import { writeFileSync } from 'fs';
import { v4 as uuid } from 'uuid';
import dotenv from "dotenv";

type Position = { free: number, loan: number, tokenId: string };
type OptionPosition = { symbol: string, markPrice: string, unrealisedPnl: string, entryPrice: string, size: string, limit: number };

dotenv.config();

const
    slippage = parseFloat(`${process.env.SLIPPAGE}`),
    symbol = `${process.env.BASE}${process.env.QUOTE}`,
    baseCurrency = `${process.env.BASE}`,
    quoteCurrency = `${process.env.QUOTE}`,
    tradeMargin = parseFloat(`${process.env.TRADE_MARGIN}`),
    optionPrecision = parseInt(`${process.env.OPTION_PRECISION}`),
    quotePrecision = parseInt(`${process.env.QUOTE_PRECISION}`),
    basePrecision = parseInt(`${process.env.BASE_PRECISION}`),
    sidewaysLimit = parseInt(`${process.env.SIDEWAYS_LIMIT}`),
    optionIM = parseFloat(`${process.env.OPTION_IM}`),
    authKey = `${process.env.AUTHPARAMKEY}`,
    tradeDataKey = `${process.env.TRADEDATAKEY}`,
    targetROI = parseFloat(`${process.env.TARGET_ROI}`),
    optionROI = parseFloat(`${process.env.OPTION_ROI}`),
    useTestnet = !!(process.env.TESTNET?.localeCompare("false", 'en', { sensitivity: 'accent' })),
    leverage = parseInt(`${process.env.LEVERAGE}`),
    months = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"],
    minSizes: { [id: string]: number } = {
        ETH: 0.08,
        NEAR: 1,
        USDT: 10,
        USDC: 10
    };

let spotStrikePrice: number = 0,
    initialEquity: number = 0,
    targetProfit: number = 0,
    sideWaysCount: number = 0,
    upperLimit: number = 0,
    lowerLimit: number = 0,
    quantity: number = 0,
    currentMoment: Date,
    expiryTime: Date | null = null,
    client: SpotClientV3,
    assetsClient: AccountAssetClient,
    unifiedClient: UnifiedMarginClient;

function floor(num: number, precision: number = quotePrecision) {
    let exp = Math.pow(10, precision);
    return Math.floor((+num * exp)) / exp;
}

async function immediateSell(symbol: string, orderQty: number, price: number, coin: string = baseCurrency) {
    orderQty = floor(orderQty, basePrecision);

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
    let borrowResponse = await client.borrowCrossMarginLoan(coin, `${quantity}`);

    if (borrowResponse.retCode == 0) return;
    await logError(`borrowFunds ${borrowResponse.retMsg}`);
}

function log(message: string) {
    let logLine = `${(new Date()).toISOString()} ${message}`;
    console.log(logLine);
    writeFileSync('logs.log', logLine, 'utf-8');
}

async function consoleAndFile(message: string) {
    console.error(message);
    await appendFile('errors.log', message + '\r\n', 'utf-8');
}

async function logError(message: string) {
    await consoleAndFile((new Date()).toISOString());
    await consoleAndFile(message);
}

function calculateNetEquity(basePosition: Position, quotePosition: Position, price: number): number {
    let qouteTotal = quotePosition.free - quotePosition.loan;
    let baseTotal = (basePosition.free - basePosition.loan) * price;
    return qouteTotal + baseTotal;
}

async function settleAccount(position: Position, price: number) {
    log(`Settling account free: ${position.free} loan: ${position.loan} price: ${price}`);
    if (position.free < position.loan) {
        let buyAmount = floor(position.loan - position.free, basePrecision);;
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

async function settleOption(optionPosition: OptionPosition | null): Promise<boolean> {
    if (!optionPosition) return false;

    let entryPrice = parseFloat(optionPosition.entryPrice);
    let uPnl = parseFloat(optionPosition.unrealisedPnl);
    let size = Math.abs(parseFloat(optionPosition.size));
    let targetProfit = entryPrice * optionROI * size;

    if (uPnl < targetProfit) return false;
    log(`settling option  ${optionPosition.symbol} ${size} upnl:${uPnl} target:${targetProfit}`);

    while (true) {
        let { retCode, retMsg } = await unifiedClient.submitOrder({
            category: 'option',
            qty: `${size}`,
            orderType: "Market",
            side: "Buy",
            symbol: optionPosition.symbol,
            timeInForce: "ImmediateOrCancel",
            orderLinkId: `${uuid()}`,
            reduceOnly: true
        });
        if (retCode == 110063) return false;
        if (retCode == 0) return true;
        logError(`settlement failed ${optionPosition.symbol} ${size} upnl:${uPnl} target:${targetProfit} (${retCode}) failed ${retMsg}`);
    }
}

async function placeStraddle(price: number, size: number): Promise<Date | null> {
    let contractPrice = Math.floor(price / 25) * 25;
    let lowerLimit = (price % 25) < 12.5 ? contractPrice - 25 : contractPrice;
    let upperLimit = lowerLimit + 50;

    let expiryTime = new Date();
    expiryTime.setUTCDate(expiryTime.getUTCDate() + ((expiryTime.getUTCHours() < 8) ? 0 : 1));
    expiryTime.setUTCHours(8);
    expiryTime.setUTCMinutes(0);
    expiryTime.setUTCSeconds(0);
    expiryTime.setUTCMilliseconds(0);

    let yearStr = `${expiryTime.getUTCFullYear()}`;
    yearStr = yearStr.substring(yearStr.length - 2);

    let putSymbol = `${baseCurrency}-${expiryTime.getUTCDate()}${months[expiryTime.getUTCMonth()]}${yearStr}-${lowerLimit}-P`;
    let callSymbol = `${baseCurrency}-${expiryTime.getUTCDate()}${months[expiryTime.getUTCMonth()]}${yearStr}-${upperLimit}-C`;

    log(`Placing straddle price:${price} size:${size} put:${putSymbol} call:${callSymbol}`);
    while (true) {
        var { retCode, retMsg } = await unifiedClient.submitOrder({
            category: 'option',
            orderType: 'Market',
            side: 'Sell',
            qty: `${size}`,
            symbol: putSymbol,
            timeInForce: 'ImmediateOrCancel',
            orderLinkId: `${uuid()}`
        });
        if (retCode == 0) break;
        logError(`put order failed ${putSymbol} ${size} (${retCode}) failed ${retCode} ${retMsg}`);
    }

    while (true) {
        var { retCode, retMsg } = await unifiedClient.submitOrder({
            category: 'option',
            orderType: 'Market',
            qty: `${size}`,
            side: 'Sell',
            symbol: callSymbol,
            timeInForce: 'ImmediateOrCancel',
            orderLinkId: `${uuid()}`
        });
        if (retCode == 0) break;
        logError(`call order failed ${callSymbol} ${size} (${retCode}) failed ${retCode} ${retMsg}`);
    }
    return expiryTime;
}

async function executeTrade() {
    let { callOption, putOption, expiry } = await getOptions();
    if (expiryTime == null) expiryTime = expiry;
    if (lowerLimit == 0 && putOption) lowerLimit = putOption.limit;
    if (upperLimit == 0 && callOption) upperLimit = callOption.limit;
    if (expiryTime && !callOption && !putOption) return;

    let { result: { loanAccountList } } = await client.getCrossMarginAccountInfo();
    let position = getPosition(loanAccountList, baseCurrency, basePrecision);
    let quotePosition = getPosition(loanAccountList, quoteCurrency, quotePrecision);
    let price: number = 0;
    while (true) {
        var { result: { price: p }, retCode, retMsg } = await client.getLastTradedPrice(symbol);
        price = floor(p, quotePrecision);
        if (isNaN(price)) continue;
        if (retCode == 0) break;
        logError(`Failed getting price (${retCode}) ${retMsg}`)
    }

    if (spotStrikePrice == 0) spotStrikePrice = price;
    if (initialEquity == 0 && !callOption && !putOption) {
        initialEquity = calculateNetEquity(position, quotePosition, price);
        let tradableEquity = initialEquity * tradeMargin;
        targetProfit = floor(tradableEquity * targetROI, quotePrecision);
        quantity = floor((tradableEquity * leverage) / price, basePrecision);
    }
    if (initialEquity == 0 && (callOption || putOption)) {
        initialEquity = calculateNetEquity(position, quotePosition, price);
        let option = callOption || putOption;
        quantity = parseFloat(`${option?.size}`);
    }

    let borrowing = position.loan >= quantity;
    let netEquity = calculateNetEquity(position, quotePosition, price);
    let profit = netEquity - initialEquity - targetProfit;

    log(`f:${position.free} l:${position.loan} p:${price} q:${quantity} skp:${spotStrikePrice} sdw:${sideWaysCount} ne:${netEquity} ie:${initialEquity} tp:${targetProfit} gp:${(netEquity - initialEquity)} e:${expiryTime} u:${upperLimit} l:${lowerLimit} c:${callOption?.unrealisedPnl} p:${putOption?.unrealisedPnl}`);

    if (!borrowing) {
        let borrowAmount = floor(quantity - position.loan, basePrecision);
        await borrowFunds(baseCurrency, borrowAmount);

        ({ result: { loanAccountList } } = await client.getCrossMarginAccountInfo());
        position = getPosition(loanAccountList, baseCurrency, basePrecision);
        quotePosition = getPosition(loanAccountList, quoteCurrency, quotePrecision);
    }

    if (sideWaysCount > sidewaysLimit && !expiryTime) {
        log(`Trading sideways ${sideWaysCount}`);

        let spotEquity = calculateNetEquity(position, quotePosition, price);
        let { result: { coin } } = await unifiedClient.getBalances(quoteCurrency);
        let availiableUnified = (!coin || coin.length == 0) ? 0 : floor(coin[0].availableBalance, quotePrecision);
        let equity = (spotEquity + availiableUnified)
        let tradableEquity = equity * tradeMargin;

        quantity = floor((tradableEquity * leverage) / ((1 + optionIM) * price), optionPrecision);
        let requiredMargin = price * quantity * optionIM;

        await settleAccount(position, price);
        await splitEquity(requiredMargin);
        expiryTime = await placeStraddle(price, quantity);

        spotStrikePrice = 0;
        sideWaysCount = 0;
        return;
    }

    if (await settleOption(putOption)) return;
    if (await settleOption(callOption)) return;

    let netPosition = floor(position.free - position.loan, basePrecision);

    if (expiryTime && !callOption && !putOption && netPosition != 0) {
        await settleAccount(position, price);
        await moveFundsToSpot();

        spotStrikePrice = 0;
        initialEquity = 0;
        sideWaysCount = 0;
        return;
    }

    if ((callOption || putOption) &&
        netPosition != 0 &&
        price < upperLimit &&
        price > lowerLimit) {
        await settleAccount(position, price);
        return;
    }

    if (putOption && price < lowerLimit && position.free > 0) {
        let sellAmount = floor(position.free, basePrecision);
        let sellPrice = floor(price * (1 - slippage), quotePrecision);
        await immediateSell(symbol, sellAmount, sellPrice);
        return;
    }

    let longAmount = floor(quantity - netPosition, basePrecision);
    if (callOption && price > upperLimit && longAmount > 0) {
        let buyAmount = floor(longAmount, basePrecision);
        let buyPrice = floor(price * (1 + slippage), quotePrecision);
        await immediateBuy(symbol, buyAmount, buyPrice);
        return;
    }

    if (callOption || putOption) return;

    if (profit > 0) {
        await settleAccount(position, price);
        await moveFundsToSpot();
        spotStrikePrice = 0;
        initialEquity = 0;
        targetProfit = 0;
        sideWaysCount = 0;
        return;
    }

    if ((price > spotStrikePrice) && (longAmount > 0)) {
        let buyAmount = floor(longAmount, basePrecision);
        let buyPrice = floor(price * (1 + slippage), quotePrecision);
        await immediateBuy(symbol, buyAmount, buyPrice);
        sideWaysCount++;
    }

    if ((price < spotStrikePrice) && (position.free > 0)) {
        let sellAmount = floor(position.free, basePrecision);
        let sellPrice = floor(price * (1 - slippage), quotePrecision);
        await immediateSell(symbol, sellAmount, sellPrice);
        sideWaysCount++;
    }

}

async function splitEquity(unifiedAmount: number) {
    unifiedAmount = floor(unifiedAmount, quotePrecision);
    if (unifiedAmount == 0) return;

    if (unifiedAmount > 0) {
        while (true) {
            var { ret_code, ret_msg } = await assetsClient.createInternalTransfer({
                amount: `${unifiedAmount}`,
                coin: quoteCurrency,
                from_account_type: "SPOT",
                to_account_type: "UNIFIED",
                transfer_id: `${uuid()}`
            });
            if (ret_code == 0) return;
            logError(`Failed to split Equity ${quoteCurrency} ${unifiedAmount} SPOT -> UNIFIED ${ret_msg}`);
        }
    }

    while (true) {
        var { ret_code, ret_msg } = await assetsClient.createInternalTransfer({
            amount: `${Math.abs(unifiedAmount)}`,
            coin: quoteCurrency,
            from_account_type: "UNIFIED",
            to_account_type: "SPOT",
            transfer_id: `${uuid()}`
        });
        if (ret_code == 0) return;
        logError(`Failed to split Equity ${quoteCurrency} ${Math.abs(unifiedAmount)} UNIFIED -> SPOT ${ret_msg}`);
    }
}

async function getOptions(): Promise<{
    callOption: OptionPosition | null,
    putOption: OptionPosition | null,
    expiry: Date | null
}> {
    let
        { result: { list } } = await unifiedClient.getPositions({ category: "option", baseCoin: baseCurrency }),
        checkExpression = new RegExp(`^${baseCurrency}-(\\d+)(\\w{3})(\\d{2})-(\\d*)-(P|C)$`),
        callOption: OptionPosition | null = null,
        putOption: OptionPosition | null = null,
        expiry: Date | null = null;

    for (let c = 0; c < (list || []).length; c++) {
        let optionPosition = <OptionPosition>list[c];
        let matches = optionPosition.symbol.match(checkExpression);

        if (!matches) continue;
        if (parseFloat(optionPosition.size) == 0) continue;
        optionPosition.limit = parseFloat(matches[4]);
        if (matches[5] == 'P') putOption = optionPosition;
        if (matches[5] == 'C') callOption = optionPosition;
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

    return { callOption, putOption, expiry };
}

async function moveFundsToSpot() {
    //fix available balance running low
    let { result: { coin } } = await unifiedClient.getBalances(quoteCurrency);
    if (!coin || coin.length == 0 || coin[0].availableBalance == 0) return

    let amount = floor(coin[0].availableBalance, quotePrecision) - 1;

    while (true) {
        var { ret_code, ret_msg } = await assetsClient.createInternalTransfer({
            amount: `${amount}`,
            coin: quoteCurrency,
            from_account_type: "UNIFIED",
            to_account_type: "SPOT",
            transfer_id: `${uuid()}`
        });
        if (ret_code == 0) return;
        logError(`Failed to move funds to SPOT ${quoteCurrency} ${Math.abs(amount)} UNIFIED -> SPOT ${ret_code} ${ret_msg}`);
    }
}

process.stdin.on('data', process.exit.bind(process, 0));
await writeFile('errors.log', `Starting session ${(new Date()).toUTCString()}\r\n`, 'utf-8');

while (true) {
    try {
        client = new SpotClientV3({
            testnet: useTestnet,
            key: process.env.API_KEY,
            secret: process.env.API_SECRET,
            recv_window: 999999
        });

        assetsClient = new AccountAssetClient({
            testnet: useTestnet,
            key: process.env.API_KEY,
            secret: process.env.API_SECRET,
            recv_window: 999999
        });

        unifiedClient = new UnifiedMarginClient({
            testnet: useTestnet,
            key: process.env.API_KEY,
            secret: process.env.API_SECRET,
            recv_window: 999999
        });

        while (true) {
            //await asyncSleep(200);
            await executeTrade();

            currentMoment = new Date();
            if (expiryTime && currentMoment > expiryTime) {
                spotStrikePrice = 0;
                initialEquity = 0;
                targetProfit = 0;
                sideWaysCount = 0;
                expiryTime = null;
                lowerLimit = 0;
                upperLimit = 0;

                let { result: { loanAccountList } } = await client.getCrossMarginAccountInfo();
                let { result: { price } } = await client.getLastTradedPrice(symbol);
                let position = getPosition(loanAccountList, baseCurrency, basePrecision);
                price = floor(price, quotePrecision);

                await settleAccount(position, price);
                await moveFundsToSpot();
            }
        }
    }
    catch (err) {
        try {
            await logError(`${err}`);
        } catch (lerr) {
            console.error(lerr);
        }
    }
}