// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../../contracts/NVDAFlashArbitrageRobinhood.sol";

// Fork tests against live Robinhood Chain state. No forge-std: only the cheatcodes used are declared.
// The public RPC prunes state within minutes, so every test forks at the head again in setUp().

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
    function swap(address, bool, int256, uint160, bytes calldata) external returns (int256, int256);
}

contract NVDAFlashArbitrageRobinhoodTest {
    Vm constant vm = Vm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);

    event log_named_decimal_uint(string key, uint256 val, uint256 decimals);
    event log_named_uint(string key, uint256 val);

    address constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    // The market under test (the live one). Both pools have the NVDA outcome token as token0.
    address constant PROPOSAL = 0x9693b5d541B64c370987A3b2A569d8db96c4D38E;
    address constant YES_NVDA = 0x0ad8133D43A3BD55d44F54e20ADE2e680C81d93c;
    address constant NO_NVDA = 0x932B9b122B43fa5ace808AA8981a056eF1cCBEa5;
    address constant YES_USDG = 0x604f72859A5c4c81BD8E7Be4079dbd5DD1b83317;
    address constant NO_USDG = 0xd3C44de013fa10Db953c3002726f5D6aF5efC8C9;
    address constant SPOT_POOL = 0xd4EB21209C4D6093f80B5b84f5C45cc093EA14a3;
    address constant YES_POOL = 0x40cd7ACf1e7bA5dc36667cb8c44c29396f96EE8a;
    address constant NO_POOL = 0x68a387a8dECaB57F6aA0Ac1F6f34F1ffdFb3B5ED;
    address constant ROUTER = 0x7834bB7f4724393043701B2A944feaE0496e00AD;

    // Large holders used only to fund this test contract on the fork.
    address constant NVDA_WHALE = 0x62AB521f71431f78ac374CdbadC6cda3c8916b6C; // NVDA/WETH pool
    address constant USDG_WHALE = 0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca; // WETH/USDG pool

    uint160 constant MIN_SQRT_RATIO = 4295128739;
    uint160 constant MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342;

    address constant TREASURY = address(0x7EA5);

    NVDAFlashArbitrageRobinhood arb;

    function setUp() public {
        vm.createSelectFork(vm.envOr("ROBINHOOD_RPC_URL", string("https://rpc.mainnet.chain.robinhood.com")));
        // This test contract is owner and operator; profit goes to a separate treasury address.
        arb = new NVDAFlashArbitrageRobinhood(PROPOSAL, YES_POOL, NO_POOL, address(this), TREASURY);
        vm.prank(NVDA_WHALE);
        IERC20Full(NVDA).transfer(address(this), 4500e18);
        vm.prank(USDG_WHALE);
        IERC20Full(USDG).transfer(address(this), 300_000e6);
    }

    // ------------------------------------------------------------------ helpers

    /// USDG per NVDA with 6 decimals, from a pool's sqrtPriceX96.
    function price(address pool) internal view returns (uint256) {
        (uint160 sqrtP,,,,,,) = IPool(pool).slot0();
        uint256 sq = uint256(sqrtP) * uint256(sqrtP);
        if (pool == SPOT_POOL) return (uint256(1e18) << 192) / sq; // token0 USDG(6), token1 NVDA(18)
        return (sq * 1e18) >> 192; // conditional pools: token0 NVDA(18), token1 USDG(6)
    }

    function sqrtOf(address pool) internal view returns (uint160 s) {
        (s,,,,,,) = IPool(pool).slot0();
    }

    /// Trade on the spot pool until its sqrt price reaches `target`.
    function moveSpotTo(uint160 target) internal {
        uint160 cur = sqrtOf(SPOT_POOL);
        if (target == cur) return;
        // sqrt price up = more NVDA per USDG = NVDA cheaper: sell NVDA (token1 in, zeroForOne false).
        bool zeroForOne = target < cur;
        IPool(SPOT_POOL).swap(address(this), zeroForOne, int256(1e30), target, "");
    }

    function uniswapV3SwapCallback(int256 d0, int256 d1, bytes calldata) external {
        if (msg.sender == SPOT_POOL) {
            if (d0 > 0) IERC20Full(USDG).transfer(msg.sender, uint256(d0));
            else IERC20Full(NVDA).transfer(msg.sender, uint256(d1));
        } else if (msg.sender == YES_POOL) {
            if (d0 > 0) IERC20Full(YES_NVDA).transfer(msg.sender, uint256(d0));
            else IERC20Full(YES_USDG).transfer(msg.sender, uint256(d1));
        } else {
            require(msg.sender == NO_POOL, "unexpected pool");
            if (d0 > 0) IERC20Full(NO_NVDA).transfer(msg.sender, uint256(d0));
            else IERC20Full(NO_USDG).transfer(msg.sender, uint256(d1));
        }
    }

    /// The spot pool's sqrt price at which spot equals the YES pool price. The YES pool is NVDA/USDG and the
    /// spot pool USDG/NVDA, so one sqrt price is the inverse of the other.
    function spotSqrtAtYesPrice() internal view returns (uint256) {
        return (uint256(1) << 192) / uint256(sqrtOf(YES_POOL));
    }

    function alignSpotToYes() internal {
        moveSpotTo(uint160(spotSqrtAtYesPrice()));
    }

    /// Repeat the arbitrage in small steps until nothing is left. Returns USDG received by the treasury.
    /// Small steps first: one oversized trade can still be profitable on average while pushing the
    /// conditional prices past spot. The live runner avoids that by choosing the profit-maximising size.
    function arbUntilDone(NVDAFlashArbitrageRobinhood.ArbitrageDirection dir) internal returns (uint256 total, uint256 n) {
        uint256[4] memory sizes = [uint256(0.1e18), 0.2e18, 0.5e18, 1e18];
        for (uint256 i = 0; i < sizes.length; i++) {
            for (uint256 k = 0; k < 80; k++) {
                uint256 before = IERC20Full(USDG).balanceOf(TREASURY);
                try arb.executeArbitrage(sizes[i], dir, 10_000) returns (uint256 p) {
                    // minProfit 0.01 USDG
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

    function assertHoldsNothing() internal view {
        address[6] memory t = [NVDA, USDG, YES_NVDA, NO_NVDA, YES_USDG, NO_USDG];
        for (uint256 i = 0; i < 6; i++) {
            require(IERC20Full(t[i]).balanceOf(address(arb)) == 0, "arb contract holds tokens");
            require(IERC20Full(t[i]).allowance(address(arb), ROUTER) == 0, "standing approval left");
        }
    }

    function logPrices(string memory tag) internal {
        emit log_named_decimal_uint(string.concat(tag, " spot"), price(SPOT_POOL), 6);
        emit log_named_decimal_uint(string.concat(tag, " YES "), price(YES_POOL), 6);
        emit log_named_decimal_uint(string.concat(tag, " NO  "), price(NO_POOL), 6);
    }

    function within(uint256 a, uint256 b, uint256 bps) internal pure returns (bool) {
        uint256 d = a > b ? a - b : b - a;
        return d * 10_000 <= b * bps;
    }

    // ------------------------------------------------------------------ tests

    /// Spot equal to both conditional prices: every direction and size must revert, at minProfit 0.
    function test_reverts_when_there_is_no_opportunity() public {
        alignSpotToYes();
        logPrices("aligned");
        uint256[3] memory sizes = [uint256(0.01e18), 0.2e18, 2e18];
        for (uint256 i = 0; i < 3; i++) {
            vm.expectPartialRevert(NVDAFlashArbitrageRobinhood.ArbitrageFailed.selector);
            arb.executeArbitrage(sizes[i], NVDAFlashArbitrageRobinhood.ArbitrageDirection.SPOT_SPLIT, 0);
            vm.expectPartialRevert(NVDAFlashArbitrageRobinhood.ArbitrageFailed.selector);
            arb.executeArbitrage(sizes[i], NVDAFlashArbitrageRobinhood.ArbitrageDirection.MERGE_SPOT, 0);
        }
        assertHoldsNothing();
    }

    /// Spot falls 2% below both conditional prices: SPOT_SPLIT pulls YES and NO down to spot at a profit.
    function test_spot_split_restores_prices_when_conditionals_are_above_spot() public {
        moveSpotTo(uint160((spotSqrtAtYesPrice() * 10_100) / 10_000)); // sqrt +1% = NVDA about 2% cheaper
        logPrices("before");
        uint256 spot = price(SPOT_POOL);
        require(price(YES_POOL) > (spot * 1015) / 1000 && price(NO_POOL) > (spot * 1015) / 1000, "setup: gap missing");

        (uint256 profit, uint256 n) = arbUntilDone(NVDAFlashArbitrageRobinhood.ArbitrageDirection.SPOT_SPLIT);
        logPrices("after ");
        emit log_named_decimal_uint("profit USDG", profit, 6);
        emit log_named_uint("arb transactions", n);

        require(profit > 1e6, "expected more than 1 USDG of profit");
        uint256 lower = price(YES_POOL) < price(NO_POOL) ? price(YES_POOL) : price(NO_POOL);
        require(within(lower, price(SPOT_POOL), 40), "conditional prices not back within 0.4% of spot");
        assertHoldsNothing();

        // Nothing left: the wrong direction and a further try both revert.
        vm.expectPartialRevert(NVDAFlashArbitrageRobinhood.ArbitrageFailed.selector);
        arb.executeArbitrage(0.5e18, NVDAFlashArbitrageRobinhood.ArbitrageDirection.MERGE_SPOT, 0);
    }

    /// Spot rises 2% above both conditional prices: MERGE_SPOT pulls YES and NO up to spot at a profit.
    function test_merge_spot_restores_prices_when_conditionals_are_below_spot() public {
        moveSpotTo(uint160((spotSqrtAtYesPrice() * 9_900) / 10_000)); // sqrt -1% = NVDA about 2% dearer
        logPrices("before");
        uint256 spot = price(SPOT_POOL);
        require(price(YES_POOL) < (spot * 985) / 1000 && price(NO_POOL) < (spot * 985) / 1000, "setup: gap missing");

        (uint256 profit, uint256 n) = arbUntilDone(NVDAFlashArbitrageRobinhood.ArbitrageDirection.MERGE_SPOT);
        logPrices("after ");
        emit log_named_decimal_uint("profit USDG", profit, 6);
        emit log_named_uint("arb transactions", n);

        require(profit > 1e6, "expected more than 1 USDG of profit");
        uint256 higher = price(YES_POOL) > price(NO_POOL) ? price(YES_POOL) : price(NO_POOL);
        require(within(higher, price(SPOT_POOL), 40), "conditional prices not back within 0.4% of spot");
        assertHoldsNothing();
    }

    /// Someone dumps conditional NVDA into both pools: MERGE_SPOT restores them.
    /// With only ONE pool pushed away, spot still lies between YES and NO, so there is no arbitrage and it reverts.
    function test_conditional_pools_pushed_away_from_spot() public {
        alignSpotToYes();
        IERC20Full(NVDA).approve(ROUTER, 6e18);
        IFutarchyRouter(ROUTER).splitPosition(PROPOSAL, NVDA, 6e18);

        // Push only the YES pool down (sell 3 YES_NVDA: token0 in, zeroForOne true).
        IPool(YES_POOL).swap(address(this), true, int256(3e18), MIN_SQRT_RATIO + 1, "");
        logPrices("one pushed ");
        require(price(YES_POOL) < (price(SPOT_POOL) * 995) / 1000, "setup: YES not pushed");
        vm.expectPartialRevert(NVDAFlashArbitrageRobinhood.ArbitrageFailed.selector);
        arb.executeArbitrage(0.1e18, NVDAFlashArbitrageRobinhood.ArbitrageDirection.MERGE_SPOT, 0);
        vm.expectPartialRevert(NVDAFlashArbitrageRobinhood.ArbitrageFailed.selector);
        arb.executeArbitrage(0.1e18, NVDAFlashArbitrageRobinhood.ArbitrageDirection.SPOT_SPLIT, 0);

        // Push the NO pool down too (sell 3 NO_NVDA: token0 in, zeroForOne true).
        IPool(NO_POOL).swap(address(this), true, int256(3e18), MIN_SQRT_RATIO + 1, "");
        logPrices("both pushed");
        (uint256 profit, uint256 n) = arbUntilDone(NVDAFlashArbitrageRobinhood.ArbitrageDirection.MERGE_SPOT);
        logPrices("after      ");
        emit log_named_decimal_uint("profit USDG", profit, 6);
        emit log_named_uint("arb transactions", n);

        require(profit > 0, "expected a profit");
        uint256 higher = price(YES_POOL) > price(NO_POOL) ? price(YES_POOL) : price(NO_POOL);
        require(within(higher, price(SPOT_POOL), 40), "conditional prices not back within 0.4% of spot");
        assertHoldsNothing();
    }

    function test_only_operator_or_owner_can_run_it_and_the_callback_is_closed() public {
        vm.prank(address(0xBEEF));
        vm.expectRevert(NVDAFlashArbitrageRobinhood.NotOperator.selector);
        arb.executeArbitrage(1e18, NVDAFlashArbitrageRobinhood.ArbitrageDirection.SPOT_SPLIT, 0);

        // The operator can run it but cannot change roles or pull tokens out.
        arb.setOperator(address(0xB07));
        alignSpotToYes();
        vm.prank(address(0xB07));
        vm.expectPartialRevert(NVDAFlashArbitrageRobinhood.ArbitrageFailed.selector); // got past the access check
        arb.executeArbitrage(0.1e18, NVDAFlashArbitrageRobinhood.ArbitrageDirection.SPOT_SPLIT, 0);
        vm.prank(address(0xB07));
        vm.expectRevert(NVDAFlashArbitrageRobinhood.NotOwner.selector);
        arb.setTreasury(address(0xB07));
        vm.prank(address(0xB07));
        vm.expectRevert(NVDAFlashArbitrageRobinhood.NotOwner.selector);
        arb.setOperator(address(0xBEEF));
        vm.prank(address(0xB07));
        vm.expectRevert(NVDAFlashArbitrageRobinhood.NotOwner.selector);
        arb.recoverTokens(USDG, 1);

        // Outside an operator-started run, nobody (not even a real pool) can drive the callback.
        vm.prank(SPOT_POOL);
        vm.expectRevert(NVDAFlashArbitrageRobinhood.NotExecuting.selector);
        arb.uniswapV3SwapCallback(1, -1, abi.encode(uint8(0)));
    }

    function test_refuses_to_deploy_for_mismatched_pools() public {
        vm.expectPartialRevert(NVDAFlashArbitrageRobinhood.PoolMismatch.selector);
        new NVDAFlashArbitrageRobinhood(PROPOSAL, NO_POOL, YES_POOL, address(this), TREASURY); // pools swapped
    }

    function test_owner_can_recover_tokens_sent_by_mistake() public {
        IERC20Full(USDG).transfer(address(arb), 5e6);
        uint256 before = IERC20Full(USDG).balanceOf(address(this));
        arb.recoverTokens(USDG, 5e6);
        require(IERC20Full(USDG).balanceOf(address(this)) == before + 5e6, "not recovered");
        assertHoldsNothing();
    }
}
