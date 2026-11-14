// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../../contracts/FutarchyMultiOptionArbitrage.sol";

// Fork tests against the live 7-option NVDA market on Robinhood Chain. No forge-std: only the cheatcodes used
// are declared. The public RPC prunes state within minutes, so every test forks at the head again in setUp().
// Opportunities are created on the fork only, by trading as this test contract with funds taken from large holders.

interface Vm {
    function createSelectFork(string calldata url) external returns (uint256);
    function envOr(string calldata name, string calldata defaultValue) external returns (string memory);
    function prank(address) external;
    function expectRevert(bytes4) external;
    function expectPartialRevert(bytes4) external; // match the selector, ignore the arguments
}

interface IERC20Full {
    function balanceOf(address) external view returns (uint256);
    function allowance(address, address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function approve(address, uint256) external returns (bool);
}

interface IPool {
    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool);
    function token0() external view returns (address);
    function token1() external view returns (address);
    function swap(address, bool, int256, uint160, bytes calldata) external returns (int256, int256);
}

contract FutarchyMultiOptionArbitrageTest {
    Vm constant vm = Vm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);

    event log_named_decimal_uint(string key, uint256 val, uint256 decimals);
    event log_named_uint(string key, uint256 val);

    address constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant PROPOSAL = 0x36dF9e82479D1B172277dD99269C88B04E68F9A7;
    address constant ROUTER = 0xc4F061Af9892fc165D0Fd7b67c008674505be5bD;
    address constant UNISWAP_FACTORY = 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA;
    address constant SPOT_POOL = 0xd4EB21209C4D6093f80B5b84f5C45cc093EA14a3; // USDG / NVDA, fee 500
    address constant FLASH_POOL = 0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca; // WETH / USDG, fee 100

    // Large holders used only to fund this test contract on the fork.
    address constant NVDA_WHALE = 0x62AB521f71431f78ac374CdbadC6cda3c8916b6C; // NVDA/WETH pool
    address constant USDG_WHALE = 0x69BfaF19C9f377BB306a89aEd9F6B07e2c1a8d9a; // WETH/USDG fee-500 pool

    address constant TREASURY = address(0x7EA5);
    uint160 constant MIN_SQRT_RATIO = 4295128739;
    uint160 constant MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342;

    // Option order: BUCK HAAS SROUJI KRESS JENSEN NONE OTHER
    uint256 constant BUCK = 0;
    uint256 constant NONE = 5;

    FutarchyMultiOptionArbitrage arb;
    FutarchyMultiOptionArbitrage.Market m;

    function pricePools() internal pure returns (address[] memory a) {
        a = new address[](7);
        a[0] = 0x9DDfF7eDf1aa655e0442cF075BDA15B42Af17e63;
        a[1] = 0x1c0472D6360985c0fdb56c0E3CC8f45fb4f29105;
        a[2] = 0x3C059789B4E7B95d2a47eDD7cf836aa9480431A6;
        a[3] = 0x3F13740430088Ba869abf791aF7A5EFEbcBFC340;
        a[4] = 0x293CE092663A20687F572Ec364BA8624f08cdCD0;
        a[5] = 0xa7bC4051264ED80A6C729ffAFcA295553A2cE6AC;
        a[6] = 0x18e30bd1912ce5ffed8F524B9B897e5Fa43384eE;
    }

    function probPools() internal pure returns (address[] memory a) {
        a = new address[](7);
        a[0] = 0xB9f74C28CCdff194A9f1B8eFB1C5A6fEd0715AB8;
        a[1] = 0x805C2dBBF5cf629E15D16b8c1b483026De66e1F7;
        a[2] = 0xA1393ca31e428A489eba8D3f66Fd026A8Db4a9a2;
        a[3] = 0x7d95947C1a9395e540A6F679d7D54E515e80843E;
        a[4] = 0x525Ed30e4bB515BA76E59F2062F4A9C3D597e312;
        a[5] = 0x32DafbFa19D6381d6D904998953dD0A5048a1656;
        a[6] = 0x9082eDcA208Ce10dA922C0A0252F3063C3C48aFA;
    }

    function setUp() public {
        vm.createSelectFork(vm.envOr("ROBINHOOD_RPC_URL", string("https://rpc.mainnet.chain.robinhood.com")));
        // This test contract is owner and operator; profit goes to a separate treasury address.
        arb = new FutarchyMultiOptionArbitrage(ROUTER, UNISWAP_FACTORY, address(this), TREASURY);
        arb.addMarket(PROPOSAL, SPOT_POOL, FLASH_POOL, pricePools(), probPools());
        m = arb.getMarket(0);
        vm.prank(NVDA_WHALE);
        IERC20Full(NVDA).transfer(address(this), 3500e18);
        vm.prank(USDG_WHALE);
        IERC20Full(USDG).transfer(address(this), 300_000e6);
    }

    // ------------------------------------------------------------------ prices

    /// Raw units of the other token per raw unit of `base`, times 1e24.
    function ratio(address pool, address base) internal view returns (uint256) {
        (uint160 sqrtP,,,,,,) = IPool(pool).slot0();
        uint256 r = IPool(pool).token0() == base ? (uint256(sqrtP) * 1e18) >> 96 : (uint256(1e18) << 96) / sqrtP;
        return (r * r) / 1e12;
    }

    /// USDG per NVDA, 6 decimals.
    function spot() internal view returns (uint256) {
        return ratio(SPOT_POOL, NVDA) / 1e6;
    }

    /// Value of NVDA if option k wins, 6 decimals.
    function price(uint256 k) internal view returns (uint256) {
        return ratio(m.pricePools[k], m.companyTokens[k]) / 1e6;
    }

    /// Probability of option k, 6 decimals (1e6 = 100%).
    function prob(uint256 k) internal view returns (uint256) {
        return ratio(m.probPools[k], m.currencyTokens[k]) / 1e18;
    }

    function sumProb() internal view returns (uint256 s) {
        for (uint256 k = 0; k < 7; k++) s += prob(k);
    }

    /// sum_k p_k * price_k, 6 decimals.
    function weightedSum() internal view returns (uint256 s) {
        for (uint256 k = 0; k < 7; k++) s += (prob(k) * price(k)) / 1e6;
    }

    function logState(string memory tag) internal {
        emit log_named_decimal_uint(string.concat(tag, " spot        "), spot(), 6);
        emit log_named_decimal_uint(string.concat(tag, " sum p*price "), weightedSum(), 6);
        emit log_named_decimal_uint(string.concat(tag, " sum p       "), sumProb(), 6);
    }

    function within(uint256 a, uint256 b, uint256 bps) internal pure returns (bool) {
        uint256 d = a > b ? a - b : b - a;
        return d * 10_000 <= b * bps;
    }

    // ------------------------------------------------------------------ trading as the test contract

    function sqrt(uint256 x) internal pure returns (uint256 y) {
        if (x == 0) return 0;
        uint256 z = (x + 1) / 2;
        y = x;
        while (z < y) {
            y = z;
            z = (x / z + z) / 2;
        }
    }

    /// Trade on the spot pool until NVDA costs `targetE6` USDG.
    function moveSpotTo(uint256 targetE6) internal {
        // Spot pool is USDG / NVDA: sqrtPrice = sqrt(NVDA wei per USDG unit) * 2^96 = sqrt(1e18 * 2^192 / targetE6).
        uint160 target = uint160(sqrt((uint256(1e18) << 192) / targetE6));
        (uint160 cur,,,,,,) = IPool(SPOT_POOL).slot0();
        if (target == cur) return;
        IPool(SPOT_POOL).swap(address(this), target < cur, int256(1e30), target, "");
    }

    function swapIn(address pool, address tokenIn, uint256 amountIn) internal {
        bool zeroForOne = IPool(pool).token0() == tokenIn;
        IPool(pool).swap(address(this), zeroForOne, int256(amountIn), zeroForOne ? MIN_SQRT_RATIO + 1 : MAX_SQRT_RATIO - 1, "");
    }

    function uniswapV3SwapCallback(int256 d0, int256 d1, bytes calldata) external {
        if (d0 > 0) IERC20Full(IPool(msg.sender).token0()).transfer(msg.sender, uint256(d0));
        else IERC20Full(IPool(msg.sender).token1()).transfer(msg.sender, uint256(d1));
    }

    function splitUsdg(uint256 amount) internal {
        IERC20Full(USDG).approve(ROUTER, amount);
        IFutarchyMultiRouter(ROUTER).splitPosition(PROPOSAL, USDG, amount);
    }

    function splitNvda(uint256 amount) internal {
        IERC20Full(NVDA).approve(ROUTER, amount);
        IFutarchyMultiRouter(ROUTER).splitPosition(PROPOSAL, NVDA, amount);
    }

    // ------------------------------------------------------------------ running the arbitrage

    /// Repeat the spot arbitrage in small steps until nothing is left (the live runner sizes by search instead).
    function runSpot(FutarchyMultiOptionArbitrage.SpotDirection dir) internal returns (uint256 total, uint256 n) {
        uint256[4] memory sizes = [uint256(0.1e18), 0.2e18, 0.5e18, 1e18];
        for (uint256 i = 0; i < sizes.length; i++) {
            for (uint256 j = 0; j < 60; j++) {
                uint256 before = IERC20Full(USDG).balanceOf(TREASURY);
                // Budget for the below-spot direction: 1.3 times the spot value of the size.
                try arb.executeSpotArbitrage(0, dir, sizes[i], 0, (sizes[i] * spot() * 13) / 10e18, 10_000) returns (uint256 p) {
                    require(IERC20Full(USDG).balanceOf(TREASURY) - before == p, "profit not paid to treasury");
                    require(p >= 10_000, "profit below minimum");
                    total += p;
                    n++;
                } catch {
                    break;
                }
            }
        }
    }

    function runProb(FutarchyMultiOptionArbitrage.ProbabilityDirection dir) internal returns (uint256 total, uint256 n) {
        uint256[4] memory sizes = [uint256(2e6), 5e6, 10e6, 25e6];
        for (uint256 i = 0; i < sizes.length; i++) {
            for (uint256 j = 0; j < 60; j++) {
                uint256 before = IERC20Full(USDG).balanceOf(TREASURY);
                try arb.executeProbabilityArbitrage(0, dir, sizes[i], 10_000) returns (uint256 p) {
                    require(IERC20Full(USDG).balanceOf(TREASURY) - before == p, "profit not paid to treasury");
                    total += p;
                    n++;
                } catch {
                    break;
                }
            }
        }
    }

    /// What the bot does over several cycles: alternate the probability and the spot arbitrage until neither
    /// finds anything. Needed when option prices differ, because the spot arbitrage then trades the unequal
    /// remainders in the probability pools and can leave the probabilities off one.
    function runUntilSettled() internal returns (uint256 total, uint256 n) {
        for (uint256 round = 0; round < 8; round++) {
            (uint256 p1, uint256 n1) = runProb(FutarchyMultiOptionArbitrage.ProbabilityDirection.PROBABILITIES_ABOVE_ONE);
            (uint256 p2, uint256 n2) = runProb(FutarchyMultiOptionArbitrage.ProbabilityDirection.PROBABILITIES_BELOW_ONE);
            (uint256 p3, uint256 n3) = runSpot(FutarchyMultiOptionArbitrage.SpotDirection.SUM_ABOVE_SPOT);
            (uint256 p4, uint256 n4) = runSpot(FutarchyMultiOptionArbitrage.SpotDirection.SUM_BELOW_SPOT);
            total += p1 + p2 + p3 + p4;
            n += n1 + n2 + n3 + n4;
            if (n1 + n2 + n3 + n4 == 0) break;
        }
    }

    function assertHoldsNothing() internal view {
        require(IERC20Full(NVDA).balanceOf(address(arb)) == 0 && IERC20Full(USDG).balanceOf(address(arb)) == 0, "holds collateral");
        require(IERC20Full(NVDA).allowance(address(arb), ROUTER) == 0 && IERC20Full(USDG).allowance(address(arb), ROUTER) == 0, "approval left");
        for (uint256 k = 0; k < 7; k++) {
            require(IERC20Full(m.companyTokens[k]).balanceOf(address(arb)) == 0, "holds option company tokens");
            require(IERC20Full(m.currencyTokens[k]).balanceOf(address(arb)) == 0, "holds option currency tokens");
            require(IERC20Full(m.companyTokens[k]).allowance(address(arb), ROUTER) == 0, "approval left");
            require(IERC20Full(m.currencyTokens[k]).allowance(address(arb), ROUTER) == 0, "approval left");
        }
    }

    function expectNoSpotArbitrage() internal {
        uint256[3] memory sizes = [uint256(0.01e18), 0.2e18, 2e18];
        for (uint256 i = 0; i < 3; i++) {
            vm.expectPartialRevert(FutarchyMultiOptionArbitrage.ArbitrageFailed.selector);
            arb.executeSpotArbitrage(0, FutarchyMultiOptionArbitrage.SpotDirection.SUM_ABOVE_SPOT, sizes[i], 0, 0, 0);
            uint256 budget = (sizes[i] * spot() * 13) / 10e18; // read before expectPartialRevert: it applies to the next call
            vm.expectPartialRevert(FutarchyMultiOptionArbitrage.ArbitrageFailed.selector);
            arb.executeSpotArbitrage(0, FutarchyMultiOptionArbitrage.SpotDirection.SUM_BELOW_SPOT, sizes[i], 0, budget, 0);
        }
    }

    function expectNoProbabilityArbitrage() internal {
        uint256[3] memory sizes = [uint256(1e6), 10e6, 100e6];
        for (uint256 i = 0; i < 3; i++) {
            vm.expectPartialRevert(FutarchyMultiOptionArbitrage.ArbitrageFailed.selector);
            arb.executeProbabilityArbitrage(0, FutarchyMultiOptionArbitrage.ProbabilityDirection.PROBABILITIES_ABOVE_ONE, sizes[i], 0);
            vm.expectPartialRevert(FutarchyMultiOptionArbitrage.ArbitrageFailed.selector);
            arb.executeProbabilityArbitrage(0, FutarchyMultiOptionArbitrage.ProbabilityDirection.PROBABILITIES_BELOW_ONE, sizes[i], 0);
        }
    }

    // ------------------------------------------------------------------ tests

    /// Spot equal to sum p*price and probabilities summing to one: every direction and size reverts at minProfit 0.
    function test_reverts_when_there_is_no_opportunity() public {
        moveSpotTo(weightedSum());
        logState("aligned");
        require(within(sumProb(), 1e6, 5), "live probabilities do not sum to one: this test needs them within 0.05%");
        expectNoSpotArbitrage();
        expectNoProbabilityArbitrage();
        assertHoldsNothing();
    }

    /// (A) Spot falls 2% below sum p*price.
    function test_A_sum_above_spot() public {
        moveSpotTo((weightedSum() * 98) / 100);
        logState("before");
        (uint256 profit, uint256 n) = runSpot(FutarchyMultiOptionArbitrage.SpotDirection.SUM_ABOVE_SPOT);
        logState("after ");
        emit log_named_decimal_uint("profit USDG", profit, 6);
        emit log_named_uint("arb transactions", n);
        require(profit > 1e6, "expected more than 1 USDG of profit");
        require(within(weightedSum(), spot(), 40), "sum not back within 0.4% of spot");
        assertHoldsNothing();
    }

    /// (B) Spot rises 2% above sum p*price.
    function test_B_sum_below_spot() public {
        moveSpotTo((weightedSum() * 102) / 100);
        logState("before");
        (uint256 profit, uint256 n) = runSpot(FutarchyMultiOptionArbitrage.SpotDirection.SUM_BELOW_SPOT);
        logState("after ");
        emit log_named_decimal_uint("profit USDG", profit, 6);
        emit log_named_uint("arb transactions", n);
        require(profit > 1e6, "expected more than 1 USDG of profit");
        require(within(weightedSum(), spot(), 40), "sum not back within 0.4% of spot");
        assertHoldsNothing();
    }

    /// (A) with option prices that differ: NONE (86% likely) is bid up, BUCK is sold down. The proceeds per
    /// option are then unequal, so the remainders go through the probability pools.
    function test_A_with_unequal_option_prices() public {
        moveSpotTo(weightedSum());
        splitUsdg(2000e6);
        splitNvda(2e18);
        swapIn(m.pricePools[NONE], m.currencyTokens[NONE], 600e6); // buy NONE_NVDA: its price rises
        swapIn(m.pricePools[BUCK], m.companyTokens[BUCK], 2e18); // sell BUCK_NVDA: its price falls
        logState("before");
        emit log_named_decimal_uint("before NVDA|NONE", price(NONE), 6);
        emit log_named_decimal_uint("before NVDA|BUCK", price(BUCK), 6);
        require(weightedSum() > (spot() * 1015) / 1000, "setup: gap missing");

        (uint256 profit, uint256 n) = runUntilSettled();
        logState("after ");
        emit log_named_decimal_uint("after  NVDA|NONE", price(NONE), 6);
        emit log_named_decimal_uint("after  NVDA|BUCK", price(BUCK), 6);
        emit log_named_decimal_uint("profit USDG", profit, 6);
        emit log_named_uint("arb transactions", n);
        require(profit > 1e6, "expected more than 1 USDG of profit");
        // The loop stops when no step earns 0.01 USDG, which leaves both identities inside a band set by
        // the pool fees and the smallest step; the two residuals partly offset each other.
        require(within(weightedSum(), spot(), 80), "sum not back within 0.8% of spot");
        require(within(sumProb(), 1e6, 60), "probabilities not back within 0.6% of one");
        assertHoldsNothing();
    }

    /// (B) with option prices that differ: NONE is sold down, BUCK is bid up.
    function test_B_with_unequal_option_prices() public {
        moveSpotTo(weightedSum());
        splitUsdg(2000e6);
        splitNvda(4e18);
        swapIn(m.pricePools[NONE], m.companyTokens[NONE], 4e18); // sell NONE_NVDA: its price falls
        swapIn(m.pricePools[BUCK], m.currencyTokens[BUCK], 400e6); // buy BUCK_NVDA: its price rises
        logState("before");
        emit log_named_decimal_uint("before NVDA|NONE", price(NONE), 6);
        emit log_named_decimal_uint("before NVDA|BUCK", price(BUCK), 6);
        require(weightedSum() < (spot() * 985) / 1000, "setup: gap missing");

        (uint256 profit, uint256 n) = runUntilSettled();
        logState("after ");
        emit log_named_decimal_uint("after  NVDA|NONE", price(NONE), 6);
        emit log_named_decimal_uint("after  NVDA|BUCK", price(BUCK), 6);
        emit log_named_decimal_uint("profit USDG", profit, 6);
        emit log_named_uint("arb transactions", n);
        require(profit > 1e6, "expected more than 1 USDG of profit");
        // The loop stops when no step earns 0.01 USDG, which leaves both identities inside a band set by
        // the pool fees and the smallest step; the two residuals partly offset each other.
        require(within(weightedSum(), spot(), 80), "sum not back within 0.8% of spot");
        require(within(sumProb(), 1e6, 60), "probabilities not back within 0.6% of one");
        assertHoldsNothing();
    }

    /// (C) Someone buys NONE in its probability pool: probabilities sum above one.
    function test_C_probabilities_above_one() public {
        swapIn(m.probPools[NONE], USDG, 60e6);
        logState("before");
        require(sumProb() > 1_010_000, "setup: sum not above 1.01");
        (uint256 profit, uint256 n) = runProb(FutarchyMultiOptionArbitrage.ProbabilityDirection.PROBABILITIES_ABOVE_ONE);
        logState("after ");
        emit log_named_decimal_uint("profit USDG", profit, 6);
        emit log_named_uint("arb transactions", n);
        require(profit > 0, "expected a profit");
        require(within(sumProb(), 1e6, 40), "probabilities not back within 0.4% of one");
        assertHoldsNothing();
    }

    /// (C) Someone sells NONE in its probability pool: probabilities sum below one.
    function test_C_probabilities_below_one() public {
        splitUsdg(100e6);
        swapIn(m.probPools[NONE], m.currencyTokens[NONE], 60e6);
        logState("before");
        require(sumProb() < 990_000, "setup: sum not below 0.99");
        (uint256 profit, uint256 n) = runProb(FutarchyMultiOptionArbitrage.ProbabilityDirection.PROBABILITIES_BELOW_ONE);
        logState("after ");
        emit log_named_decimal_uint("profit USDG", profit, 6);
        emit log_named_uint("arb transactions", n);
        require(profit > 0, "expected a profit");
        require(within(sumProb(), 1e6, 40), "probabilities not back within 0.4% of one");
        assertHoldsNothing();
    }

    function test_roles_and_closed_callbacks() public {
        vm.prank(address(0xBEEF));
        vm.expectRevert(FutarchyMultiOptionArbitrage.NotOperator.selector);
        arb.executeSpotArbitrage(0, FutarchyMultiOptionArbitrage.SpotDirection.SUM_ABOVE_SPOT, 1e18, 0, 0, 0);
        vm.prank(address(0xBEEF));
        vm.expectRevert(FutarchyMultiOptionArbitrage.NotOperator.selector);
        arb.executeProbabilityArbitrage(0, FutarchyMultiOptionArbitrage.ProbabilityDirection.PROBABILITIES_ABOVE_ONE, 1e6, 0);

        // The operator cannot change roles, add markets or pull tokens out.
        arb.setOperator(address(0xB07));
        vm.prank(address(0xB07));
        vm.expectRevert(FutarchyMultiOptionArbitrage.NotOwner.selector);
        arb.setTreasury(address(0xB07));
        vm.prank(address(0xB07));
        vm.expectRevert(FutarchyMultiOptionArbitrage.NotOwner.selector);
        arb.addMarket(PROPOSAL, SPOT_POOL, FLASH_POOL, pricePools(), probPools());
        vm.prank(address(0xB07));
        vm.expectRevert(FutarchyMultiOptionArbitrage.NotOwner.selector);
        arb.recoverTokens(USDG, 1);

        // Outside a run, nobody (not even a registered pool) can drive the callbacks.
        vm.prank(SPOT_POOL);
        vm.expectRevert(FutarchyMultiOptionArbitrage.NotExecuting.selector);
        arb.uniswapV3SwapCallback(1, -1, abi.encode(uint8(0), uint256(0)));
        vm.prank(FLASH_POOL);
        vm.expectRevert(FutarchyMultiOptionArbitrage.NotExecuting.selector);
        arb.uniswapV3FlashCallback(0, 0, abi.encode(uint8(4), uint256(1e6)));

        // A switched-off market cannot be traded.
        arb.setMarketActive(0, false);
        vm.prank(address(0xB07));
        vm.expectPartialRevert(FutarchyMultiOptionArbitrage.MarketInactive.selector);
        arb.executeSpotArbitrage(0, FutarchyMultiOptionArbitrage.SpotDirection.SUM_ABOVE_SPOT, 1e18, 0, 0, 0);
    }

    function test_refuses_markets_with_wrong_pools() public {
        address[] memory pp = pricePools();
        (pp[0], pp[1]) = (pp[1], pp[0]); // BUCK and HAAS price pools swapped
        vm.expectPartialRevert(FutarchyMultiOptionArbitrage.PoolMismatch.selector);
        arb.addMarket(PROPOSAL, SPOT_POOL, FLASH_POOL, pp, probPools());

        // A price pool offered as a probability pool.
        address[] memory qq = probPools();
        qq[5] = pricePools()[5];
        vm.expectPartialRevert(FutarchyMultiOptionArbitrage.PoolMismatch.selector);
        arb.addMarket(PROPOSAL, SPOT_POOL, FLASH_POOL, pricePools(), qq);

        // A flash pool that does not hold the currency (the NVDA/WETH pool).
        vm.expectPartialRevert(FutarchyMultiOptionArbitrage.PoolMismatch.selector);
        arb.addMarket(PROPOSAL, SPOT_POOL, NVDA_WHALE, pricePools(), probPools());
    }

    function test_owner_can_recover_tokens_sent_by_mistake() public {
        IERC20Full(USDG).transfer(address(arb), 5e6);
        uint256 before = IERC20Full(USDG).balanceOf(address(this));
        arb.recoverTokens(USDG, 5e6);
        require(IERC20Full(USDG).balanceOf(address(this)) == before + 5e6, "not recovered");
        assertHoldsNothing();
    }
}
