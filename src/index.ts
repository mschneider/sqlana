import {
  AddressLookupTableAccount,
  Connection,
  PublicKey,
} from "@solana/web3.js";
import postgres, { Sql } from "postgres";
import { Group, fetchMangoGroupConfig } from "./mango";

const { DATABASE_URL, RPC_URL, WALLET_PK } = process.env;

const conn = new Connection(RPC_URL!, "confirmed");
const walletPk = new PublicKey(WALLET_PK!);

const PROGRAM = {
  JUPITER_V4: new PublicKey("JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB"),
};

async function collectSignatures(sql: Sql, walletId: number) {
  const findLastSlot = await sql`
  SELECT slot
  FROM sol.txs_confirmed t
  WHERE wallet_id = ${walletId}
  ORDER BY slot DESC
  LIMIT 1`;

  let lastSlot, until;
  if (findLastSlot.length == 1) {
    lastSlot = findLastSlot[0]["slot"];

    const findLastSignatureInPreviousSlot = await sql`
    SELECT signature
    FROM sol.txs_confirmed t
    WHERE wallet_id = ${walletId} AND slot < ${lastSlot}
    ORDER BY id DESC
    LIMIT 1`;

    if (findLastSignatureInPreviousSlot.length == 1) {
      until = findLastSignatureInPreviousSlot[0]["signature"];
    }
  }

  let before;
  while (true) {
    console.log(
      `fetching addresses for wallet ${WALLET_PK} lastSlot=${lastSlot} before=${before} until=${until}`
    );
    let signatures = await conn.getSignaturesForAddress(walletPk, {
      before,
      until,
    });
    console.log(`fetched ${signatures.length} signatures`);

    if (signatures.length == 0) {
      setTimeout(() => collectSignatures(sql, walletId), 5000);

      return;
    }

    await sql`INSERT INTO sol.txs_confirmed ${sql(
      signatures.reverse().map((s) => ({
        wallet_id: walletId,
        slot: s.slot,
        signature: s.signature,
        error: s.err,
        memo: s.memo,
        block_time: s.blockTime,
      }))
    )} ON CONFLICT DO NOTHING`;

    before = signatures[0].signature;
  }
}

async function collectTransactions(sql: Sql, walletId: number, group: Group) {
  let toCollect =
    await sql`SELECT id, signature FROM sol.txs_confirmed WHERE wallet_id = ${walletId} AND action is NULL LIMIT 50`;
  // console.log(`collect transaction details for ${toCollect.length}`);

  let txs = await conn.getTransactions(
    toCollect.map((s) => s.signature),
    { commitment: "confirmed", maxSupportedTransactionVersion: 0 }
  );

  let actions = await Promise.all(
    txs.map(async (tx, i) => {
      // TODO needs a cache
      const lookupTableAccounts = await Promise.all(
        tx!.transaction.message.addressTableLookups.map(async (l) => ({
          key: l.accountKey,
          data: await conn.getAccountInfo(l.accountKey),
        }))
      );

      let action: string | undefined,
        timestamp,
        computeUnitLimit,
        computeUnitPrice;

      tx?.transaction.message.compiledInstructions.forEach((ix) => {
        const programId = tx.transaction.message
          .getAccountKeys({
            addressLookupTableAccounts: lookupTableAccounts.map(
              ({ key, data }) =>
                new AddressLookupTableAccount({
                  key,
                  state: AddressLookupTableAccount.deserialize(data!.data),
                })
            ),
          })
          .get(ix.programIdIndex)!;

        if (PROGRAM.JUPITER_V4.equals(programId)) {
          action = "swap";
        }
      });

      console.log({ action, sig: tx?.transaction.signatures[0].toString() });
      switch (action) {
        case "swap":
          let preTokenBalances = new Map(
            tx?.meta?.preTokenBalances
              ?.filter((b) => walletPk.toString() == b.owner)
              .map((b) => [
                group.tokens.find((t) => t.mint === b.mint)?.symbol || b.mint,
                b.uiTokenAmount,
              ])
          );

          let postTokenBalances = new Map(
            tx?.meta?.postTokenBalances
              ?.filter((b) => walletPk.toString() == b.owner)
              .map((b) => [
                group.tokens.find((t) => t.mint === b.mint)?.symbol || b.mint,
                b.uiTokenAmount,
              ])
          );

          const symbols = Array.from(preTokenBalances.keys());
          if (symbols.length != 2) {
            console.error(
              `can only parse txs with 2 symbols, found pre=${symbols} post=${Array.from(
                postTokenBalances.keys()
              )}`
            );
            return "undefined";
          } else {
            let quoteIndex = symbols.indexOf("USDC");
            if (quoteIndex == -1) {
              console.error(`could not identify USDC as quote in ${symbols}`);
              return "undefined";
            }

            const [symbolQuote] = symbols.splice(quoteIndex, 1);
            const [symbolBase] = symbols;
            const tokenQuote = group.tokens.find(
              (t) => t.symbol === symbolQuote
            );
            const tokenBase = group.tokens.find((t) => t.symbol === symbolBase);
            if (!tokenQuote || !tokenBase) {
              console.error(
                `could not identify quote & base toke in ${symbols}`
              );
              return "undefined";
            } else {
              const amountNativeQuote =
                Number(postTokenBalances.get(symbolQuote)?.amount) -
                Number(preTokenBalances.get(symbolQuote)?.amount);
              const amountNativeBase =
                Number(postTokenBalances.get(symbolBase)?.amount) -
                Number(preTokenBalances.get(symbolBase)?.amount);

              const toInsert = {
                tx_id: toCollect[i].id,
                client_timestamp: timestamp || null,
                compute_unit_limit: computeUnitLimit || null,
                compute_unit_price: computeUnitPrice || null,
                symbol_base: symbolBase,
                symbol_quote: symbolQuote,
                amount_native_base: amountNativeBase,
                amount_native_quote: amountNativeQuote,
              };
              // console.log({ toInsert });
              await sql`INSERT INTO sol.swaps ${sql(toInsert)}`;
            }
          }
      }

      return action || "undefined";
    })
  );

  if (actions.length > 0) {
    await sql.unsafe(
      `
      UPDATE sol.txs_confirmed as t1
      SET action = t2.action
      FROM (VALUES ${actions
        .map((_, i) => `($${2 * i + 1}::int, $${2 * i + 2}::text)`)
        .join(",")}
      ) AS t2(id, action)
      WHERE t1.id = t2.id
    `,
      actions.flatMap((a, i) => [toCollect[i].id, a])
    );
  }

  printPnl(sql, group);

  setTimeout(() => collectTransactions(sql, walletId, group), 1000);
}

async function printPnl(sql: Sql, group: Group) {
  const swapSummary = await sql`
  SELECT symbol_base, SUM(amount_native_base) AS amount_native_base, symbol_quote, SUM(amount_native_quote) AS amount_native_quote
  FROM sol.swaps
  GROUP BY symbol_base, symbol_quote`;

  for (let {
    symbol_base,
    amount_native_base,
    symbol_quote,
    amount_native_quote,
  } of swapSummary) {
    const [{ native_price }] = await sql`
    SELECT amount_native_quote * -1.0 / amount_native_base AS native_price
    FROM sol.swaps
    WHERE symbol_base = ${symbol_base} AND symbol_quote = ${symbol_quote}
    ORDER BY tx_id DESC
    LIMIT 1`;

    console.log(
      "PNL",
      symbol_base,
      (Number(amount_native_base) * Number(native_price) +
        Number(amount_native_quote)) /
        Math.pow(
          10,
          group.tokens.find((t) => t.symbol === symbol_quote)!.decimals
        )
    );
  }
}

async function main() {
  const group = await fetchMangoGroupConfig();

  const sql = postgres(DATABASE_URL!, {
    prepare: false,
    types: {
      bigint: postgres.BigInt,
    },
    // debug: console.log,
  });
  const findWallet =
    await sql`SELECT id, label FROM sol.accounts WHERE address = ${WALLET_PK!}`;

  if (findWallet.length != 1) {
    console.error(
      `found wallet ${WALLET_PK} ${findWallet.length} times ${findWallet}`
    );
    process.exit(-1);
  }

  const { id: walletId, label } = findWallet[0];
  console.log(`indexing wallet ${label} id=${walletId} pk=${WALLET_PK}`);

  await collectSignatures(sql, walletId);
  await collectTransactions(sql, walletId, group);
}

main();
