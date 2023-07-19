exports.up = async sql => {
  await sql`create schema sol`;
  await sql`create table sol.accounts(
    id SERIAL NOT NULL PRIMARY KEY,
    address VARCHAR(45) NOT NULL,
    label VARCHAR(127) NULL
  )`;
  await sql`insert into sol.accounts ${sql([
    {address: process.env.WALLET_PK, label: 'dev-wallet'},
  ])}`;
  await sql`create table sol.txs_confirmed(
    id SERIAL NOT NULL PRIMARY KEY,
    wallet_id INT NOT NULL,
    signature VARCHAR(88) UNIQUE NOT NULL,
    slot BIGINT NOT NULL,
    error json NULL,
    memo TEXT NULL,
    block_time INT NULL,
    action VARCHAR(31) NULL
  )`;

  await sql`create table sol.swaps(
    tx_id INT NOT NULL PRIMARY KEY,
    client_timestamp BIGINT NULL,
    compute_unit_limit BIGINT NULL,
    compute_unit_price BIGINT NULL,
    symbol_base VARCHAR(31) NOT NULL,
    symbol_quote VARCHAR(31) NOT NULL,
    amount_native_base BIGINT NOT NULL,
    amount_native_quote BIGINT NOT NULL
  )`;
};

exports.down = async sql => {
  await sql`drop table sol.swaps`;
  await sql`drop table sol.txs_confirmed`;
  await sql`drop table sol.accounts`;
  await sql`drop schema sol`;
};
