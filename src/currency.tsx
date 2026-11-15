import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  DEFAULT_CURRENCY,
  FALLBACK_RATES_PAYLOAD,
  formatMoney,
  isCurrencyCode,
  type CurrencyCode,
  type RatesPayload,
} from '../shared/currency.ts';

const STORAGE_KEY = 'astris.currency';

interface CurrencyContextValue {
  currency: CurrencyCode;
  setCurrency: (currency: CurrencyCode) => void;
  rates: RatesPayload;
  /** Formats an amount that is held in USD in the selected currency. */
  fmt: (amountUsd: number) => string;
}

const CurrencyContext = createContext<CurrencyContextValue>({
  currency: DEFAULT_CURRENCY,
  setCurrency: () => {},
  rates: FALLBACK_RATES_PAYLOAD,
  fmt: (usd) => formatMoney(usd, DEFAULT_CURRENCY),
});

/**
 * The display currency and its exchange rates. All amounts in the app are USD; components call
 * `fmt(usd)` and re-render when the traveller switches currency. The choice is remembered in
 * localStorage (if the browser allows it); rates come from `/api/rates` with a built-in fallback.
 */
export function CurrencyProvider({ children }: { children: ReactNode }) {
  const [currency, setCurrencyState] = useState<CurrencyCode>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (isCurrencyCode(saved)) return saved;
    } catch {
      // storage blocked (private window, etc.): start from the default
    }
    return DEFAULT_CURRENCY;
  });
  const [rates, setRates] = useState<RatesPayload>(FALLBACK_RATES_PAYLOAD);

  useEffect(() => {
    let active = true;
    fetch('/api/rates')
      .then((res) => (res.ok ? res.json() : null))
      .then((payload: RatesPayload | null) => {
        if (active && payload?.rates) setRates(payload);
      })
      .catch(() => {
        // keep the fallback table
      });
    return () => {
      active = false;
    };
  }, []);

  const setCurrency = useCallback((next: CurrencyCode) => {
    setCurrencyState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // not persisted; still applies for this session
    }
  }, []);

  const value = useMemo<CurrencyContextValue>(
    () => ({
      currency,
      setCurrency,
      rates,
      fmt: (amountUsd) => formatMoney(amountUsd, currency, rates.rates),
    }),
    [currency, setCurrency, rates]
  );

  return <CurrencyContext.Provider value={value}>{children}</CurrencyContext.Provider>;
}

export function useCurrency(): CurrencyContextValue {
  return useContext(CurrencyContext);
}
