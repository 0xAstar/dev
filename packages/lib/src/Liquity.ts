import { Signer } from "ethers";
import { Provider } from "ethers/providers";
import { bigNumberify, BigNumberish, BigNumber } from "ethers/utils";

import { Decimal, Decimalish, Difference } from "../utils/Decimal";

import { CDPManager } from "../types/ethers/CDPManager";
import { CDPManagerFactory } from "../types/ethers/CDPManagerFactory";
import { SortedCDPs } from "../types/ethers/SortedCDPs";
import { SortedCDPsFactory } from "../types/ethers/SortedCDPsFactory";
import { PriceFeed } from "../types/ethers/PriceFeed";
import { PriceFeedFactory } from "../types/ethers/PriceFeedFactory";
import { PoolManager } from "../types/ethers/PoolManager";
import { PoolManagerFactory } from "../types/ethers/PoolManagerFactory";
import { ActivePool } from "../types/ethers/ActivePool";
import { ActivePoolFactory } from "../types/ethers/ActivePoolFactory";
import { DefaultPool } from "../types/ethers/DefaultPool";
import { DefaultPoolFactory } from "../types/ethers/DefaultPoolFactory";
import { StabilityPool } from "../types/ethers/StabilityPool";
import { StabilityPoolFactory } from "../types/ethers/StabilityPoolFactory";
import { CLVToken } from "../types/ethers/CLVToken";
import { CLVTokenFactory } from "../types/ethers/CLVTokenFactory";

interface Trovish {
  readonly collateral?: Decimalish;
  readonly debt?: Decimalish;
  readonly pendingCollateralReward?: Decimalish;
  readonly pendingDebtReward?: Decimalish;

  readonly _stake?: Decimalish;
}

const calculateCollateralRatio = (collateral: Decimal, debt: Decimal, price: Decimalish) => {
  return collateral.mulDiv(price, debt);
};

type TroveChange = { property: "collateral" | "debt"; difference: Difference };

export class Trove {
  readonly collateral: Decimal;
  readonly debt: Decimal;
  readonly pendingCollateralReward: Decimal;
  readonly pendingDebtReward: Decimal;

  readonly _stake: Decimal;

  get isEmpty() {
    return (
      this.collateral.isZero &&
      this.debt.isZero &&
      this.pendingCollateralReward.isZero &&
      this.pendingDebtReward.isZero
    );
  }

  get collateralAfterReward() {
    return this.collateral.add(this.pendingCollateralReward);
  }

  get debtAfterReward() {
    return this.debt.add(this.pendingDebtReward);
  }

  collateralRatio(price: Decimalish): Decimal {
    return calculateCollateralRatio(this.collateral, this.debt, price);
  }

  collateralRatioAfterRewards(price: Decimalish): Decimal {
    return calculateCollateralRatio(this.collateralAfterReward, this.debtAfterReward, price);
  }

  collateralRatioIsBelowMinimum(price: Decimalish) {
    return this.collateralRatioAfterRewards(price).lt(Liquity.MINIMUM_COLLATERAL_RATIO);
  }

  collateralRatioIsBelowCritical(price: Decimalish) {
    return this.collateralRatioAfterRewards(price).lt(Liquity.CRITICAL_COLLATERAL_RATIO);
  }

  constructor({
    collateral = 0,
    debt = 0,
    pendingCollateralReward = 0,
    pendingDebtReward = 0,
    _stake = collateral
  }: Trovish = {}) {
    this.collateral = Decimal.from(collateral);
    this.debt = Decimal.from(debt);
    this.pendingCollateralReward = Decimal.from(pendingCollateralReward);
    this.pendingDebtReward = Decimal.from(pendingDebtReward);
    this._stake = Decimal.from(_stake);
  }

  add({ collateral = 0, debt = 0, pendingCollateralReward = 0, pendingDebtReward = 0 }: Trovish) {
    return new Trove({
      collateral: this.collateralAfterReward.add(collateral).add(pendingCollateralReward),
      debt: this.debtAfterReward.add(debt).add(pendingDebtReward)
    });
  }

  addCollateral(collateral: Decimalish) {
    return this.add({ collateral });
  }

  addDebt(debt: Decimalish) {
    return this.add({ debt });
  }

  subtract({
    collateral = 0,
    debt = 0,
    pendingCollateralReward = 0,
    pendingDebtReward = 0
  }: Trovish) {
    return new Trove({
      collateral: this.collateralAfterReward.sub(collateral).sub(pendingCollateralReward),
      debt: this.debtAfterReward.sub(debt).sub(pendingDebtReward)
    });
  }

  subtractCollateral(collateral: Decimalish) {
    return this.subtract({ collateral });
  }

  subtractDebt(debt: Decimalish) {
    return this.subtract({ debt });
  }

  setCollateral(collateral: Decimalish) {
    return new Trove({
      collateral,
      debt: this.debtAfterReward
    });
  }

  setDebt(debt: Decimalish) {
    return new Trove({
      collateral: this.collateralAfterReward,
      debt
    });
  }

  whatChanged(that: Trove): TroveChange | undefined {
    if (!that.collateralAfterReward.eq(this.collateralAfterReward)) {
      return {
        property: "collateral",
        difference: Difference.between(that.collateralAfterReward, this.collateralAfterReward)
      };
    }
    if (!that.debtAfterReward.eq(this.debtAfterReward)) {
      return {
        property: "debt",
        difference: Difference.between(that.debtAfterReward, this.debtAfterReward)
      };
    }
  }

  apply({ property, difference }: TroveChange) {
    switch (property) {
      case "collateral":
        if (difference.positive) {
          return this.addCollateral(difference.absoluteValue!);
        } else if (difference.negative) {
          if (difference.absoluteValue!.lt(this.collateralAfterReward)) {
            return this.subtractCollateral(difference.absoluteValue!);
          } else {
            return this.setCollateral(0);
          }
        }
      case "debt":
        if (difference.positive) {
          return this.addDebt(difference.absoluteValue!);
        } else if (difference.negative) {
          if (difference.absoluteValue!.lt(this.debtAfterReward)) {
            return this.subtractDebt(difference.absoluteValue!);
          } else {
            return this.setDebt(0);
          }
        }
    }
  }
}

// yeah, sounds stupid...
interface StabilityDepositish {
  readonly deposit?: Decimalish;
  readonly pendingCollateralGain?: Decimalish;
  readonly pendingDepositLoss?: Decimalish;
}

export class StabilityDeposit {
  readonly deposit: Decimal;
  readonly pendingCollateralGain: Decimal;
  readonly pendingDepositLoss: Decimal;

  get isEmpty() {
    return (
      this.deposit.isZero && this.pendingCollateralGain.isZero && this.pendingDepositLoss.isZero
    );
  }

  get depositAfterLoss() {
    return this.deposit.sub(this.pendingDepositLoss);
  }

  constructor({
    deposit = 0,
    pendingCollateralGain = 0,
    pendingDepositLoss = 0
  }: StabilityDepositish) {
    this.deposit = Decimal.from(deposit);
    this.pendingCollateralGain = Decimal.from(pendingCollateralGain);

    if (this.deposit.gt(pendingDepositLoss)) {
      this.pendingDepositLoss = Decimal.from(pendingDepositLoss);
    } else {
      this.pendingDepositLoss = this.deposit;
    }
  }

  calculateDifference(that: StabilityDeposit) {
    if (!that.depositAfterLoss.eq(this.depositAfterLoss)) {
      return Difference.between(that.depositAfterLoss, this.depositAfterLoss);
    }
  }

  apply(difference: Difference) {
    if (difference.positive) {
      return new StabilityDeposit({ deposit: this.depositAfterLoss.add(difference.absoluteValue!) });
    } else if (difference.negative) {
      return new StabilityDeposit({
        deposit: difference.absoluteValue!.lt(this.depositAfterLoss)
          ? this.depositAfterLoss.sub(difference.absoluteValue!)
          : 0
      });
    }
  }
}

const addressZero = "0x0000000000000000000000000000000000000000";

enum CDPStatus {
  nonExistent,
  active,
  closed
}

export type LiquityTransactionOverrides = {
  nonce?: BigNumberish | Promise<BigNumberish>;
  gasLimit?: BigNumberish | Promise<BigNumberish>;
  gasPrice?: BigNumberish | Promise<BigNumberish>;
  chainId?: number | Promise<number>;
};

const debouncingDelayMs = 50;

const debounce = (listener: () => void) => {
  let timeoutId: number | undefined = undefined;

  return () => {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }

    timeoutId = setTimeout(() => {
      listener();
      timeoutId = undefined;
    }, debouncingDelayMs);
  };
};

export class Liquity {
  public static readonly CRITICAL_COLLATERAL_RATIO: Decimal = Decimal.from(1.5);
  public static readonly MINIMUM_COLLATERAL_RATIO: Decimal = Decimal.from(1.1);

  public static useHint = true;

  public readonly userAddress?: string;

  private readonly cdpManager: CDPManager;
  private readonly priceFeed: PriceFeed;
  private readonly sortedCDPs: SortedCDPs;
  private readonly clvToken: CLVToken;
  private readonly poolManager: PoolManager;
  private readonly activePool: ActivePool;
  private readonly defaultPool: DefaultPool;
  private readonly stabilityPool: StabilityPool;

  constructor(
    contracts: {
      cdpManager: CDPManager;
      priceFeed: PriceFeed;
      sortedCDPs: SortedCDPs;
      clvToken: CLVToken;
      poolManager: PoolManager;
      activePool: ActivePool;
      defaultPool: DefaultPool;
      stabilityPool: StabilityPool;
    },
    userAddress?: string
  ) {
    this.cdpManager = contracts.cdpManager;
    this.priceFeed = contracts.priceFeed;
    this.sortedCDPs = contracts.sortedCDPs;
    this.clvToken = contracts.clvToken;
    this.poolManager = contracts.poolManager;
    this.activePool = contracts.activePool;
    this.defaultPool = contracts.defaultPool;
    this.stabilityPool = contracts.stabilityPool;
    this.userAddress = userAddress;
  }

  static async connect(cdpManagerAddress: string, signerOrProvider: Signer | Provider) {
    const userAddress = Signer.isSigner(signerOrProvider)
      ? await signerOrProvider.getAddress()
      : undefined;

    const cdpManager = CDPManagerFactory.connect(cdpManagerAddress, signerOrProvider);

    const [
      priceFeed,
      sortedCDPs,
      clvToken,
      [poolManager, activePool, defaultPool, stabilityPool]
    ] = await Promise.all([
      cdpManager.priceFeedAddress().then(address => {
        return PriceFeedFactory.connect(address, signerOrProvider);
      }),
      cdpManager.sortedCDPsAddress().then(address => {
        return SortedCDPsFactory.connect(address, signerOrProvider);
      }),
      cdpManager.clvTokenAddress().then(address => {
        return CLVTokenFactory.connect(address, signerOrProvider);
      }),
      cdpManager.poolManagerAddress().then(address => {
        const poolManager = PoolManagerFactory.connect(address, signerOrProvider);

        return Promise.all([
          Promise.resolve(poolManager),

          poolManager.activePoolAddress().then(address => {
            return ActivePoolFactory.connect(address, signerOrProvider);
          }),
          poolManager.defaultPoolAddress().then(address => {
            return DefaultPoolFactory.connect(address, signerOrProvider);
          }),
          poolManager.stabilityPoolAddress().then(address => {
            return StabilityPoolFactory.connect(address, signerOrProvider);
          })
        ]);
      })
    ]);

    return new Liquity(
      {
        cdpManager,
        priceFeed,
        sortedCDPs,
        poolManager,
        activePool,
        defaultPool,
        stabilityPool,
        clvToken
      },
      userAddress
    );
  }

  private requireAddress(): string {
    if (!this.userAddress) {
      throw Error("An address is required");
    }
    return this.userAddress;
  }

  private static computePendingReward(
    snapshotValue: Decimal,
    currentValue: Decimal,
    stake: Decimal
  ) {
    const rewardPerStake = currentValue.sub(snapshotValue);
    const reward = rewardPerStake.mul(stake);

    return reward;
  }

  async getTrove(address = this.requireAddress()): Promise<Trove> {
    const cdp = await this.cdpManager.CDPs(address);

    if (cdp.status !== CDPStatus.active) {
      return new Trove();
    }

    const snapshot = await this.cdpManager.rewardSnapshots(address);
    const snapshotETH = new Decimal(snapshot.ETH);
    const snapshotCLVDebt = new Decimal(snapshot.CLVDebt);

    const L_ETH = new Decimal(await this.cdpManager.L_ETH());
    const L_CLVDebt = new Decimal(await this.cdpManager.L_CLVDebt());

    const stake = new Decimal(cdp.stake);
    const pendingCollateralReward = Liquity.computePendingReward(snapshotETH, L_ETH, stake);
    const pendingDebtReward = Liquity.computePendingReward(snapshotCLVDebt, L_CLVDebt, stake);

    return new Trove({
      collateral: new Decimal(cdp.coll),
      debt: new Decimal(cdp.debt),
      pendingCollateralReward,
      pendingDebtReward,
      _stake: new Decimal(cdp.stake)
    });
  }

  watchTrove(onTroveChanged: (trove: Trove) => void, address = this.requireAddress()) {
    const { CDPCreated, CDPUpdated } = this.cdpManager.filters;
    const { EtherSent } = this.activePool.filters;

    const cdpEventFilters = [CDPCreated(address, null), CDPUpdated(address, null, null, null)];
    const etherSent = EtherSent(null, null);

    const cdpListener = () => {
      this.getTrove(address).then(onTroveChanged);
    };

    const liquidationListener = debounce(cdpListener);

    const etherSentListener = (toAddress: string, amount: any) => {
      if (toAddress === this.defaultPool.address) {
        liquidationListener();
      }
    };

    cdpEventFilters.forEach(filter => this.cdpManager.on(filter, cdpListener));
    this.activePool.on(etherSent, etherSentListener);

    return () => {
      cdpEventFilters.forEach(filter => this.cdpManager.removeListener(filter, cdpListener));
      this.activePool.removeListener(etherSent, etherSentListener);
    };
  }

  async _findHintForCollateralRatio(collateralRatio: Decimal, price: Decimal, address: string) {
    if (!Liquity.useHint) {
      return address;
    }

    const numberOfTroves = (await this.getNumberOfTroves()).toNumber();

    if (!numberOfTroves || collateralRatio.infinite) {
      return addressZero;
    }

    const numberOfTrials = bigNumberify(Math.ceil(Math.sqrt(numberOfTroves))); // XXX not multiplying by 10 here

    const approxHint = await this.cdpManager.getApproxHint(
      collateralRatio.bigNumber,
      bigNumberify(numberOfTrials)
    );

    const { 0: hint } = await this.sortedCDPs.findInsertPosition(
      collateralRatio.bigNumber,
      price.bigNumber,
      approxHint,
      approxHint
    );

    return hint;
  }

  _findHint(trove: Trove, price: Decimal, address: string) {
    const collateralRatio = trove.collateralRatioAfterRewards(price);

    return this._findHintForCollateralRatio(collateralRatio, price, address);
  }

  async openTrove(trove: Trove, price: Decimalish, overrides?: LiquityTransactionOverrides) {
    const address = this.requireAddress();

    return this.cdpManager.openLoan(
      trove.debt.bigNumber,
      await this._findHint(trove, Decimal.from(price), address),
      { value: trove.collateral.bigNumber, ...overrides }
    );
  }

  async closeTrove(overrides?: LiquityTransactionOverrides) {
    return this.cdpManager.closeLoan({ ...overrides });
  }

  async depositEther(
    initialTrove: Trove,
    depositedEther: Decimalish,
    price: Decimalish,
    overrides?: LiquityTransactionOverrides,
    address = this.requireAddress()
  ) {
    const finalTrove = initialTrove.addCollateral(depositedEther);

    return this.cdpManager.addColl(
      address,
      await this._findHint(finalTrove, Decimal.from(price), address),
      {
        value: Decimal.from(depositedEther).bigNumber,
        ...overrides
      }
    );
  }

  async withdrawEther(
    initialTrove: Trove,
    withdrawnEther: Decimalish,
    price: Decimalish,
    overrides?: LiquityTransactionOverrides
  ) {
    const address = this.requireAddress();
    const finalTrove = initialTrove.subtractCollateral(withdrawnEther);

    return this.cdpManager.withdrawColl(
      Decimal.from(withdrawnEther).bigNumber,
      await this._findHint(finalTrove, Decimal.from(price), address),
      { ...overrides }
    );
  }

  async borrowQui(
    initialTrove: Trove,
    borrowedQui: Decimalish,
    price: Decimalish,
    overrides?: LiquityTransactionOverrides
  ) {
    const address = this.requireAddress();
    const finalTrove = initialTrove.addDebt(borrowedQui);

    return this.cdpManager.withdrawCLV(
      Decimal.from(borrowedQui).bigNumber,
      await this._findHint(finalTrove, Decimal.from(price), address),
      { ...overrides }
    );
  }

  async repayQui(
    initialTrove: Trove,
    repaidQui: Decimalish,
    price: Decimalish,
    overrides?: LiquityTransactionOverrides
  ) {
    const address = this.requireAddress();
    const finalTrove = initialTrove.subtractDebt(repaidQui);

    return this.cdpManager.repayCLV(
      Decimal.from(repaidQui).bigNumber,
      await this._findHint(finalTrove, Decimal.from(price), address),
      { ...overrides }
    );
  }

  getNumberOfTroves() {
    return this.cdpManager.getCDPOwnersCount();
  }

  watchNumberOfTroves(onNumberOfTrovesChanged: (numberOfTroves: BigNumber) => void) {
    const { CDPUpdated } = this.cdpManager.filters;
    const cdpUpdated = CDPUpdated(null, null, null, null);

    const cdpUpdatedListener = debounce(() => {
      this.getNumberOfTroves().then(onNumberOfTrovesChanged);
    });

    this.cdpManager.on(cdpUpdated, cdpUpdatedListener);

    return () => {
      this.cdpManager.removeListener(cdpUpdated, cdpUpdatedListener);
    };
  }

  async getPrice() {
    return new Decimal(await this.priceFeed.getPrice());
  }

  watchPrice(onPriceChanged: (price: Decimal) => void) {
    const { PriceUpdated } = this.priceFeed.filters;
    const priceUpdated = PriceUpdated(null);

    const priceUpdatedListener = () => {
      this.getPrice().then(onPriceChanged);
    };

    this.priceFeed.on(priceUpdated, priceUpdatedListener);

    return () => {
      this.priceFeed.removeListener(priceUpdated, priceUpdatedListener);
    };
  }

  async setPrice(price: Decimalish, overrides?: LiquityTransactionOverrides) {
    return this.priceFeed.setPrice(Decimal.from(price).bigNumber, { ...overrides });
  }

  async updatePrice(overrides?: LiquityTransactionOverrides) {
    return this.priceFeed.updatePrice_Testnet({ ...overrides });
  }

  async getTotal() {
    const [activeCollateral, activeDebt, liquidatedCollateral, closedDebt] = await Promise.all(
      [
        this.poolManager.getActiveColl(),
        this.poolManager.getActiveDebt(),
        this.poolManager.getLiquidatedColl(),
        this.poolManager.getClosedDebt()
      ].map(promise => promise.then(bigNumber => new Decimal(bigNumber)))
    );

    return new Trove({
      collateral: activeCollateral,
      debt: activeDebt,
      pendingCollateralReward: liquidatedCollateral,
      pendingDebtReward: closedDebt
    });
  }

  watchTotal(onTotalChanged: (total: Trove) => void) {
    const { Transfer } = this.clvToken.filters;

    const mint = Transfer(addressZero, null, null);
    const burn = Transfer(null, addressZero, null);
    const transferFromDefaultPool = Transfer(this.defaultPool.address, null, null);
    const transferToDefaultPool = Transfer(null, this.defaultPool.address, null);

    const clvEventFilters = [mint, burn, transferFromDefaultPool, transferToDefaultPool];

    const totalListener = debounce(() => {
      this.getTotal().then(onTotalChanged);
    });

    clvEventFilters.forEach(filter => this.clvToken.on(filter, totalListener));
    this.activePool.provider.on(this.activePool.address, totalListener);
    this.defaultPool.provider.on(this.defaultPool.address, totalListener);

    return () => {
      clvEventFilters.forEach(filter => this.clvToken.removeListener(filter, totalListener));
      this.activePool.provider.removeListener(this.activePool.address, totalListener);
      this.defaultPool.provider.removeListener(this.defaultPool.address, totalListener);
    };
  }

  async liquidate(address: string, overrides?: LiquityTransactionOverrides) {
    return this.cdpManager.liquidate(address, { ...overrides });
  }

  async liquidateUpTo(
    maximumNumberOfTrovesToLiquidate: BigNumberish,
    overrides?: LiquityTransactionOverrides
  ) {
    return this.cdpManager.liquidateCDPs(maximumNumberOfTrovesToLiquidate, { ...overrides });
  }

  async getStabilityDeposit(address = this.requireAddress()) {
    const deposit = new Decimal(await this.poolManager.deposit(address));

    const snapshot = await this.poolManager.snapshot(address);
    const snapshotETH = new Decimal(snapshot.ETH);
    const snapshotCLV = new Decimal(snapshot.CLV);

    const S_ETH = new Decimal(await this.poolManager.S_ETH());
    const S_CLV = new Decimal(await this.poolManager.S_CLV());

    const pendingCollateralGain = Liquity.computePendingReward(snapshotETH, S_ETH, deposit);
    const pendingDepositLoss = Liquity.computePendingReward(snapshotCLV, S_CLV, deposit);

    return new StabilityDeposit({ deposit, pendingCollateralGain, pendingDepositLoss });
  }

  watchStabilityDeposit(
    onStabilityDepositChanged: (deposit: StabilityDeposit) => void,
    address = this.requireAddress()
  ) {
    const { UserDepositChanged } = this.poolManager.filters;
    const { EtherSent } = this.activePool.filters;

    const userDepositChanged = UserDepositChanged(address, null);
    const etherSent = EtherSent(null, null);

    const userDepositChangedListener = () => {
      this.getStabilityDeposit(address).then(onStabilityDepositChanged);
    };

    const stabilityPoolOffsetListener = debounce(userDepositChangedListener);

    const etherSentListener = (toAddress: string) => {
      if (toAddress === this.stabilityPool.address) {
        stabilityPoolOffsetListener();
      }
    };

    this.poolManager.on(userDepositChanged, userDepositChangedListener);
    this.activePool.on(etherSent, etherSentListener);

    return () => {
      this.poolManager.removeListener(userDepositChanged, userDepositChangedListener);
      this.activePool.removeListener(etherSent, etherSentListener);
    };
  }

  depositQuiInStabilityPool(depositedQui: Decimalish, overrides?: LiquityTransactionOverrides) {
    return this.poolManager.provideToSP(Decimal.from(depositedQui).bigNumber, { ...overrides });
  }

  withdrawQuiFromStabilityPool(withdrawnQui: Decimalish, overrides?: LiquityTransactionOverrides) {
    return this.poolManager.withdrawFromSP(Decimal.from(withdrawnQui).bigNumber, { ...overrides });
  }

  async transferCollateralGainToTrove(
    deposit: StabilityDeposit,
    initialTrove: Trove,
    price: Decimalish,
    overrides?: LiquityTransactionOverrides
  ) {
    const address = this.requireAddress();
    const finalTrove = initialTrove.addCollateral(deposit.pendingCollateralGain);

    return this.poolManager.withdrawFromSPtoCDP(
      address,
      await this._findHint(finalTrove, Decimal.from(price), address),
      { ...overrides }
    );
  }

  async getQuiInStabilityPool() {
    return new Decimal(await this.poolManager.getStabilityPoolCLV());
  }

  watchQuiInStabilityPool(onQuiInStabilityPoolChanged: (quiInStabilityPool: Decimal) => void) {
    const { Transfer } = this.clvToken.filters;

    const transferQuiFromStabilityPool = Transfer(this.stabilityPool.address, null, null);
    const transferQuiToStabilityPool = Transfer(null, this.stabilityPool.address, null);

    const stabilityPoolQuiFilters = [transferQuiFromStabilityPool, transferQuiToStabilityPool];

    const stabilityPoolQuiListener = debounce(() => {
      this.getQuiInStabilityPool().then(onQuiInStabilityPoolChanged);
    });

    stabilityPoolQuiFilters.forEach(filter => this.clvToken.on(filter, stabilityPoolQuiListener));

    return () =>
      stabilityPoolQuiFilters.forEach(filter =>
        this.clvToken.removeListener(filter, stabilityPoolQuiListener)
      );
  }

  async getQuiBalance(address = this.requireAddress()) {
    return new Decimal(await this.clvToken.balanceOf(address));
  }

  watchQuiBalance(onQuiBalanceChanged: (balance: Decimal) => void, address = this.requireAddress()) {
    const { Transfer } = this.clvToken.filters;
    const transferQuiFromUser = Transfer(address, null, null);
    const transferQuiToUser = Transfer(null, address, null);

    const quiTransferFilters = [transferQuiFromUser, transferQuiToUser];

    const quiTransferListener = () => {
      this.getQuiBalance(address).then(onQuiBalanceChanged);
    };

    quiTransferFilters.forEach(filter => this.clvToken.on(filter, quiTransferListener));

    return () =>
      quiTransferFilters.forEach(filter =>
        this.clvToken.removeListener(filter, quiTransferListener)
      );
  }

  sendQui(toAddress: string, amount: Decimalish, overrides?: LiquityTransactionOverrides) {
    return this.clvToken.transfer(toAddress, Decimal.from(amount).bigNumber, { ...overrides });
  }

  async _findRedemptionHints(
    exchangedQui: Decimal,
    price: Decimal
  ): Promise<[string, string, Decimal]> {
    if (!Liquity.useHint) {
      return [addressZero, addressZero, Decimal.INFINITY];
    }

    const {
      firstRedemptionHint,
      partialRedemptionHintICR
    } = await this.cdpManager.getRedemptionHints(exchangedQui.bigNumber, price.bigNumber);

    const collateralRatio = new Decimal(partialRedemptionHintICR);

    return [
      firstRedemptionHint,
      collateralRatio.nonZero
        ? await this._findHintForCollateralRatio(collateralRatio, price, addressZero)
        : addressZero,
      collateralRatio
    ];
  }

  async redeemCollateral(
    exchangedQui: Decimalish,
    price: Decimalish,
    overrides?: LiquityTransactionOverrides
  ) {
    exchangedQui = Decimal.from(exchangedQui);
    price = Decimal.from(price);

    const [
      firstRedemptionHint,
      partialRedemptionHint,
      partialRedemptionHintICR
    ] = await this._findRedemptionHints(exchangedQui, price);

    return this.cdpManager.redeemCollateral(
      exchangedQui.bigNumber,
      firstRedemptionHint,
      partialRedemptionHint,
      partialRedemptionHintICR.bigNumber,
      {
        ...overrides
      }
    );
  }

  async getLastTroves(numberOfTroves: number) {
    if (numberOfTroves < 1) {
      throw new Error("numberOfTroves must be at least 1");
    }

    const troves: Promise<[string, Trove, StabilityDeposit]>[] = [];

    const getTroveWithAddress = (address: string) =>
      Promise.all<Trove, StabilityDeposit>([
        this.getTrove(address),
        this.getStabilityDeposit(address)
      ]).then(([trove, deposit]): [string, Trove, StabilityDeposit] => [address, trove, deposit]);

    let i = 0;
    let currentAddress = await this.sortedCDPs.getLast();

    while (currentAddress !== addressZero) {
      troves.push(getTroveWithAddress(currentAddress));

      if (++i === numberOfTroves) {
        break;
      }

      currentAddress = await this.sortedCDPs.getPrev(currentAddress);
    }

    return Promise.all(troves);
  }

  async _getFirstTroveAddress() {
    const first = await this.sortedCDPs.getFirst();

    return first !== addressZero ? first : undefined;
  }

  async _getNextTroveAddress(address: string) {
    const next = await this.sortedCDPs.getNext(address);

    return next !== addressZero ? next : undefined;
  }
}