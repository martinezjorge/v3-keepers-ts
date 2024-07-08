import {
  MarginAccount,
  ParclV3Sdk,
  ProgramAccount,
  getExchangePda,
  translateAddress,
} from "@parcl-oss/v3-sdk";
import {
  Commitment,
  Connection,
  Keypair,
} from "@solana/web3.js";
import bs58 from "bs58";
import { RunLiquidatorParams } from "./types";
import { 
  getAllMarketAddressesByExchange, 
  getMarketAccountsByExchange, 
  getMarketMapAndPriceFeedMap, 
  scanAndLiquidateMarginAccounts, 
  createMarginAccountsDataFrame,
  getMarginAccountsAtBoundedMarginLevels,
} from "./utils";
import * as dotenv from "dotenv";
dotenv.config();

(async function main() {
  console.log("Starting liquidator");
  if (process.env.RPC_URL === undefined) {
    throw new Error("Missing rpc url");
  }
  if (process.env.LIQUIDATOR_MARGIN_ACCOUNT === undefined) {
    throw new Error("Missing liquidator margin account");
  }
  if (process.env.PRIVATE_KEY === undefined) {
    throw new Error("Missing liquidator signer");
  }
  // Note: only handling single exchange
  const [exchangeAddress] = getExchangePda(0);
  const liquidatorMarginAccount = translateAddress(process.env.LIQUIDATOR_MARGIN_ACCOUNT);
  const liquidatorSigner = Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY));
  const priceFeedsUpdateInterval = parseInt(process.env.PRICE_FEEDS_UPDATE_INTERVAL ?? "30");
  const allMarginAccountsScanInterval = parseInt(process.env.ALL_MARGIN_ACCOUNTS_SCAN_INTERVAL ?? "300");
  const commitment = process.env.COMMITMENT as Commitment | undefined;
  const sdk = new ParclV3Sdk({ rpcUrl: process.env.RPC_URL, commitment });
  const connection = new Connection(process.env.RPC_URL, commitment);
  await runLiquidator({
    sdk,
    connection,
    priceFeedsUpdateInterval,
    allMarginAccountsScanInterval,
    exchangeAddress,
    liquidatorSigner,
    liquidatorMarginAccount,
  });
})();

export async function runLiquidator({
  sdk,
  connection,
  priceFeedsUpdateInterval,
  allMarginAccountsScanInterval,
  exchangeAddress,
  liquidatorSigner,
  liquidatorMarginAccount,
}: RunLiquidatorParams): Promise<void> {

  // Initial Price Feed Read In
  console.log("Scanning Latest Prices");
  let [exchange, markets, priceFeeds] = await getMarketAccountsByExchange(sdk, exchangeAddress);
  let timePriceFeedsLastUpdated = performance.now();
  
  // Margin Account DataFrames
  console.log("Full Margin Account Scan");
  let allMarginAccounts = await sdk.accountFetcher.getAllMarginAccounts();
  let allMarginAccountsDataFrame = createMarginAccountsDataFrame(allMarginAccounts, exchange, markets, priceFeeds);
  let priorityMarginAccountsDataFrame = getMarginAccountsAtBoundedMarginLevels(allMarginAccountsDataFrame, 0, 1.1e+16);
  let allMarginAccountAddresses = allMarginAccountsDataFrame.getColumn("addresses").toArray();
  let priorityMarginAccounts: (ProgramAccount<MarginAccount> | undefined)[];
  priorityMarginAccounts = allMarginAccounts.filter((marginAccount) => allMarginAccountAddresses.includes(marginAccount.address));
  let timeAllMarginAccountsLastScanned = performance.now();

  allMarginAccountsDataFrame.writeCSV(`./data/All-Margin-Accounts-${Date.now()/1000}.csv`);
  priorityMarginAccountsDataFrame.writeCSV(`./data/Priority-Margin-Accounts-${Date.now()/1000}.csv`);

  // eslint-disable-next-line no-constant-condition
  while (true) {

    // price feeds
    if (performance.now() - timePriceFeedsLastUpdated >= priceFeedsUpdateInterval * 1000) {
      console.log("Price Feed Update Routine");
      let priceFeedRoutineStart = performance.now();

      // update price feeds
      const allMarketAddresses = getAllMarketAddressesByExchange(exchangeAddress, exchange);
      const allMarkets = await sdk.accountFetcher.getMarkets(allMarketAddresses);
      [markets, priceFeeds] = await getMarketMapAndPriceFeedMap(sdk, allMarkets);

      priorityMarginAccounts = await sdk.accountFetcher.getMarginAccounts(priorityMarginAccountsDataFrame.getColumn("addresses").toArray());
      priorityMarginAccountsDataFrame = createMarginAccountsDataFrame(priorityMarginAccounts, exchange, markets, priceFeeds); 
      priorityMarginAccountsDataFrame = getMarginAccountsAtBoundedMarginLevels(priorityMarginAccountsDataFrame, 0, 1.1e+16);
      let priorityMarginAccountAddresses = priorityMarginAccountsDataFrame.getColumn("addresses").toArray();
      priorityMarginAccounts = priorityMarginAccounts.filter((marginAccount) => priorityMarginAccountAddresses.includes(marginAccount?.address));
      await scanAndLiquidateMarginAccounts(sdk, connection, priorityMarginAccounts, markets, priceFeeds, exchange, liquidatorSigner, liquidatorMarginAccount);
      console.log(`Scanned ${priorityMarginAccounts.length} priority margin accounts.`);
      timePriceFeedsLastUpdated = performance.now();
      console.log(`Price Feed Update Routine took ${timePriceFeedsLastUpdated - priceFeedRoutineStart} milliseconds.`);
    }

    // allMarginAccounts
    if (performance.now() - timeAllMarginAccountsLastScanned >= allMarginAccountsScanInterval * 1000) {
      console.log("Full Margin Account Scan Routine");
      let allMarginAccountsRoutineStart = performance.now();

      allMarginAccounts = await sdk.accountFetcher.getAllMarginAccounts();
      allMarginAccountsDataFrame = createMarginAccountsDataFrame(allMarginAccounts, exchange, markets, priceFeeds);
      priorityMarginAccountsDataFrame = getMarginAccountsAtBoundedMarginLevels(allMarginAccountsDataFrame, 0, 1.1e+16);
      allMarginAccountAddresses = allMarginAccountsDataFrame.getColumn("addresses").toArray();
      priorityMarginAccounts = allMarginAccounts.filter((marginAccount) => allMarginAccountAddresses.includes(marginAccount.address));

      allMarginAccountsDataFrame.writeCSV(`./data/All-Margin-Accounts-${Date.now()/1000}.csv`);
      priorityMarginAccountsDataFrame.writeCSV(`./data/Priority-Margin-Accounts-${Date.now()/1000}.csv`);

      timeAllMarginAccountsLastScanned = performance.now();

      console.log(`Scanned ${priorityMarginAccounts.length} margin accounts`);
      console.log(`Full Margin Account Scan routine took ${timeAllMarginAccountsLastScanned - allMarginAccountsRoutineStart} milliseconds`);
    }

    // sleep for a second
    console.log("Waiting a second");
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}