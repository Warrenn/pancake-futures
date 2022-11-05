import { SpotClientV3, SpotCrossMarginBorrowingInfoRequest } from "bybit-api";
import dotenv from "dotenv";

dotenv.config();

const symbol = 'ETHUSDT';
const strikePrice = 365;
const quantity = 6;

let client = new SpotClientV3({
    testnet: !!(process.env.TESTNET?.localeCompare("false", 'en', { sensitivity: 'accent' })),
    key: process.env.API_KEY,
    secret: process.env.API_SECRET
});

//first get the current position
//if we are holding a short and long nothing to do
//if we are holding a short only check price if we need to do a long
//if we are not holding any position initiate the short order with condition


while (true) {
    let xaci = await client.getCrossMarginAccountInfo();
    let { result: { price } } = await client.getLastTradedPrice(symbol);
    let rsp = await client.borrowCrossMarginLoan('ETH', `${quantity}`);
    //if (price < strikePrice) {
    let orderResponse = await client.submitOrder({
        orderType: "MARKET",
        orderQty: `${quantity}`,
        side: "Sell",
        symbol: symbol,
        // triggerPrice: `${strikePrice}`,
        // orderCategory: 1
    });        //place the short order immediately

    let rr = await client.repayCrossMarginLoan('ETH', `${quantity}`);
    console.log(orderResponse);
}