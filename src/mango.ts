export interface Group {
  publicKey: string;
  cluster: string;
  name: string;
  mangoProgramId: string;
  insuranceVault: string;
  insuranceMint: string;
  insuranceMintDecimals: number;
  perpMarkets: PerpMarket[];
  tokens: Token[];
  stubOracles: StubOracle[];
  serum3Markets: Serum3Market[];
}

export interface PerpMarket {
  group: string;
  publicKey: string;
  marketIndex: number;
  name: string;
  baseDecimals: number;
  baseLotSize: number;
  quoteLotSize: number;
  oracle: string;
  active: boolean;
  settleTokenIndex: number;
}

export interface Token {
  group: string;
  mint: string;
  tokenIndex: number;
  symbol: string;
  decimals: number;
  oracle: string;
  mintInfo: string;
  banks: Bank[];
  active: boolean;
}

export interface Bank {
  bankNum: number;
  publicKey: string;
}

export interface StubOracle {
  group: string;
  mint: string;
  publicKey: string;
}

export interface Serum3Market {
  group: string;
  publicKey: string;
  marketIndex: number;
  name: string;
  baseTokenIndex: number;
  quoteTokenIndex: number;
  serumProgram: string;
  serumMarketExternal: string;
  active: boolean;
}

export async function fetchMangoGroupConfig(): Promise<Group> {
  const response = await fetch("https://api.mngo.cloud/data/v4/group-metadata");
  const jsonData = await response.json();

  return jsonData.groups.find(
    (g: Group) => g.publicKey === "78b8f4cGCwmZ9ysPFMWLaLTkkaYnUjwMJYStWe5RTSSX"
  );
}
