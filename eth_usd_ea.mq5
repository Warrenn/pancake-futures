//+------------------------------------------------------------------+
//|                                                      newtest.mq5 |
//|                                  Copyright 2022, MetaQuotes Ltd. |
//|                                             https://www.mql5.com |
//+------------------------------------------------------------------+
#property copyright "Copyright 2022, MetaQuotes Ltd."
#property link      "https://www.mql5.com"
#property version   "1.00"

#define MACD_MAGIC 1234502

#include <Trade\PositionInfo.mqh>
#include <Trade\Trade.mqh>
#include <Trade\SymbolInfo.mqh>

input int      inp_streak_range     = 15000;
input int      inp_ema_period       = 32;
input double   inp_cost             = 3000;
input double   inp_threshold        = 0.0;
input double   inp_take_profit      = 0.0;

int               m_handle_ema;                 // moving average indicator handle
int               m_handle_macd;
CPositionInfo     m_position;
CTrade            m_trade;
MqlTick           m_tick;
MqlDateTime       m_current_time;
double            m_entyPrice;
double            m_ema_current;
double            m_ema_previous;
double            m_buff_EMA[];                 // EMA indicator buffer
double            m_buff_MACD_main[];           // MACD indicator main buffer
int               m_negative_streak;
int               m_positive_streak;
double            m_upper;

//+------------------------------------------------------------------+
//|                                                                  |
//+------------------------------------------------------------------+
bool InitIndicators(void)
  {
//--- create EMA indicator and add it to collection
   if((m_handle_ema=iMA(NULL,0,inp_ema_period,0,MODE_EMA,PRICE_CLOSE))==INVALID_HANDLE)
     {
      printf("Error creating EMA indicator");
      return(false);
     }

   if((m_handle_macd=iMACD(NULL,0,12,26,9,PRICE_CLOSE))==INVALID_HANDLE)
     {
      printf("Error creating MACD indicator");
      return(false);
     }
//--- succeed
   return(true);
  }

//+------------------------------------------------------------------+
//| Expert initialization function                                   |
//+------------------------------------------------------------------+
int OnInit()
  {
//---
//---
   m_negative_streak = 0;
   if(!InitIndicators())
      return(INIT_FAILED);

   m_trade.SetExpertMagicNumber(MACD_MAGIC); // magic
   m_trade.SetMarginMode();
   m_trade.SetTypeFillingBySymbol(Symbol());

   ArraySetAsSeries(m_buff_EMA,true);
   ArraySetAsSeries(m_buff_MACD_main,true);
   return(INIT_SUCCEEDED);
  }
//+------------------------------------------------------------------+
//| Expert deinitialization function                                 |
//+------------------------------------------------------------------+
void OnDeinit(const int reason)
  {
//---

  }
//+------------------------------------------------------------------+
//| Expert tick function                                             |
//+------------------------------------------------------------------+
void OnTick()
  {
   if(CopyBuffer(m_handle_ema,0,0,2,m_buff_EMA)!=2)
      return;
   if(CopyBuffer(m_handle_macd,0,0,2,m_buff_MACD_main)!=2)
      return;

   double openPrice = 0;
   double stopLoss = 0;
   double macd = m_buff_MACD_main[0];

   m_ema_current =   m_buff_EMA[0];
   m_ema_previous= m_buff_EMA[1];

   SymbolInfoTick(Symbol(),m_tick);
   bool holdingPosition = m_position.Select(Symbol());

   if(holdingPosition)
     {
      openPrice = m_position.PriceOpen();
      stopLoss = m_position.StopLoss();
     }

   if(stopLoss>0)
      return;

   if(m_ema_current < m_ema_previous)
     {
      m_negative_streak++;
      m_positive_streak = 0;
     }
   else
     {
      m_negative_streak = 0;
      m_positive_streak++;
     }

   if(m_negative_streak > inp_streak_range && !holdingPosition && macd < 0 )
     {
      m_upper = m_tick.ask;
      double volume = NormalizeDouble(inp_cost / m_tick.bid, _Digits);
      if(!m_trade.Sell(volume))
        {
         printf("Error opening BUY position by %s : '%s'",Symbol(),m_trade.ResultComment());
         printf("Open parameters : price=%f,TP=%f",m_upper,0.0);
        }
      return;
     }


   if(!holdingPosition)
      return;

   double closePrice = openPrice * (1 - inp_take_profit);
   if(m_tick.ask <= closePrice && stopLoss == 0 && m_negative_streak < m_positive_streak)
     {
      if(m_trade.PositionModify(Symbol(),closePrice,0.0))
        {
         m_upper = 0;
        }
      else
        {
         printf("Error modifying position by %s : '%s'",Symbol(),m_trade.ResultComment());
         printf("Modify parameters : SL=%f,TP=%f",openPrice,0.0);
        }
      return;
     }

   double threshold = m_upper * (1 + inp_threshold);
   if(m_tick.ask >= threshold && stopLoss == 0 && threshold > 0 && macd > 0)
     {
      printf("loss occured %f bid %f ask %f diff %f", openPrice, m_tick.bid, m_tick.ask, (m_tick.ask - openPrice));
      m_upper = 0;
      if(!m_trade.PositionClose(Symbol()))
         printf("error closing position by %s : '%s'",Symbol(),m_trade.ResultComment());
      return;
     }
  }
//+------------------------------------------------------------------+
//| Trade function                                                   |
//+------------------------------------------------------------------+
void OnTrade()
  {
//---

  }
//+------------------------------------------------------------------+
//| TradeTransaction function                                        |
//+------------------------------------------------------------------+
void OnTradeTransaction(const MqlTradeTransaction& trans,
                        const MqlTradeRequest& request,
                        const MqlTradeResult& result)
  {
//---

  }
//+------------------------------------------------------------------+
