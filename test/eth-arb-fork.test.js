/**
 * Mainnet-fork tests for ETHFlashArbitrageV1 (ETH/USDS futarchy market).
 *
 * Proves on a fork of real mainnet state:
 *   1. USDS <-> USDC round trip through the Sky route (UsdsPsmWrapper, 1:1)
 *   2. splitPosition / mergePositions via the FutarchyRouter for both collaterals
 *   3. Full flash-arb paths end-to-end on the real conditional pools (tiny size -
 *      the pools only hold a few dollars). Prices are currently aligned, so the
 *      round trip loses swap fees + price impact; the contract is pre-funded with
 *      a small WETH subsidy so the atomic repay check passes, and we assert the
 *      loss stays well under that subsidy and balances are coherent.
 *
 * Run:  RPC_URL=https://ethereum.publicnode.com npx hardhat test test/eth-arb-fork.test.js
 * (RPC_URL on the command line overrides the repo .env, which points at Gnosis.)
 */

const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { JsonRpcProvider } = require("ethers");

const FORK_RPC = process.env.FORK_RPC || "https://ethereum.publicnode.com";

// Market constants (verified on-chain, see spec + contract natspec)
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const USDS = "0xdC035D45d973E3EC169d2276DDab16f1e407384F";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const PROPOSAL = "0x0d78b95fca9f3e1b588271A330b0D6f731eC38aA";
const FUTARCHY_ROUTER = "0xAc9Bf8EbA6Bd31f8E8c76f8E8B2AAd0BD93f98Dc";
const YES_WETH = "0x642a8d92B4FC8ECd504DFc169Fbd15275354E620";
const NO_WETH = "0x98c4c36AaBA743C5A320355111bA51559fdD8E21";
const YES_USDS = "0xee3db3b2f2296a92d8e57bf61e9423B0e7f5e7e1";
const NO_USDS = "0x6C833e3787D024048F357eBA54134C358ebB1971";
// Sky UsdsPsmWrapper - verified on-chain (see ETHFlashArbitrageV1 natspec)
const USDS_PSM_WRAPPER = "0xA188EEC8F81263234dA3622A406892F3D630f98c";

// Whales (balances checked on mainnet 2026-08-07)
const WETH_WHALE = "0x4d5F47FA6A74757f35C14fD3a6Ef8E3C9BC514E8"; // aEthWETH, ~353k WETH
const USDS_WHALE = "0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD"; // sUSDS, ~4.7B USDS

const ERC20_ABI = [
    "function balanceOf(address) view returns (uint256)",
    "function transfer(address,uint256) returns (bool)",
    "function approve(address,uint256) returns (bool)",
];
const ROUTER_ABI = [
    "function splitPosition(address proposal, address collateralToken, uint256 amount)",
    "function mergePositions(address proposal, address collateralToken, uint256 amount)",
];
const WRAPPER_ABI = [
    "function buyGem(address usr, uint256 gemAmt) returns (uint256 usdsInWad)",
    "function sellGem(address usr, uint256 gemAmt) returns (uint256 usdsOutWad)",
];

const SPOT_SPLIT = 0;
const MERGE_SPOT = 1;

describe("ETHFlashArbitrageV1 mainnet fork", function () {
    this.timeout(600000);

    let user, weth, usds, usdc, yesWeth, noWeth, yesUsds, noUsds, router, wrapper, arb;

    async function impersonate(addr) {
        await network.provider.request({ method: "hardhat_impersonateAccount", params: [addr] });
        await network.provider.send("hardhat_setBalance", [addr, "0x1000000000000000000"]); // 1 ETH gas
        return await ethers.getSigner(addr);
    }

    before(async function () {
        // Fork mainnet at a recent block (repo .env RPC_URL points at Gnosis, so
        // reset explicitly to the mainnet fork RPC regardless of environment).
        const remote = new JsonRpcProvider(FORK_RPC);
        const latest = await remote.getBlockNumber();
        await network.provider.request({
            method: "hardhat_reset",
            params: [{ forking: { jsonRpcUrl: FORK_RPC, blockNumber: latest - 30 } }],
        });
        console.log(`      forked mainnet at block ${latest - 30} via ${FORK_RPC}`);

        [user] = await ethers.getSigners();
        weth = new ethers.Contract(WETH, ERC20_ABI, user);
        usds = new ethers.Contract(USDS, ERC20_ABI, user);
        usdc = new ethers.Contract(USDC, ERC20_ABI, user);
        yesWeth = new ethers.Contract(YES_WETH, ERC20_ABI, user);
        noWeth = new ethers.Contract(NO_WETH, ERC20_ABI, user);
        yesUsds = new ethers.Contract(YES_USDS, ERC20_ABI, user);
        noUsds = new ethers.Contract(NO_USDS, ERC20_ABI, user);
        router = new ethers.Contract(FUTARCHY_ROUTER, ROUTER_ABI, user);
        wrapper = new ethers.Contract(USDS_PSM_WRAPPER, WRAPPER_ABI, user);

        // Fund test account: 1 WETH + 2000 USDS from whales
        const wethWhale = await impersonate(WETH_WHALE);
        await weth.connect(wethWhale).transfer(user.address, ethers.parseEther("1"));
        const usdsWhale = await impersonate(USDS_WHALE);
        await usds.connect(usdsWhale).transfer(user.address, ethers.parseEther("2000"));
    });

    it("1. USDS <-> USDC round trip through Sky UsdsPsmWrapper is 1:1", async function () {
        const usdsStart = await usds.balanceOf(user.address);
        const usdcStart = await usdc.balanceOf(user.address);

        // USDS -> USDC (buyGem takes the USDC amount; pulls 1000e18 USDS at tin/tout=0)
        await usds.approve(USDS_PSM_WRAPPER, ethers.MaxUint256);
        await wrapper.buyGem(user.address, 1000_000000n); // 1000 USDC
        expect(await usdc.balanceOf(user.address)).to.equal(usdcStart + 1000_000000n);
        expect(await usds.balanceOf(user.address)).to.equal(usdsStart - ethers.parseEther("1000"));

        // USDC -> USDS
        await usdc.approve(USDS_PSM_WRAPPER, ethers.MaxUint256);
        await wrapper.sellGem(user.address, 1000_000000n);
        expect(await usdc.balanceOf(user.address)).to.equal(usdcStart);
        expect(await usds.balanceOf(user.address)).to.equal(usdsStart);
    });

    it("2a. splitPosition / mergePositions round trip for WETH collateral", async function () {
        const amount = ethers.parseEther("0.001");
        const wethStart = await weth.balanceOf(user.address);

        await weth.approve(FUTARCHY_ROUTER, ethers.MaxUint256);
        await router.splitPosition(PROPOSAL, WETH, amount);
        expect(await yesWeth.balanceOf(user.address)).to.equal(amount);
        expect(await noWeth.balanceOf(user.address)).to.equal(amount);
        expect(await weth.balanceOf(user.address)).to.equal(wethStart - amount);

        await yesWeth.approve(FUTARCHY_ROUTER, ethers.MaxUint256);
        await noWeth.approve(FUTARCHY_ROUTER, ethers.MaxUint256);
        await router.mergePositions(PROPOSAL, WETH, amount);
        expect(await yesWeth.balanceOf(user.address)).to.equal(0n);
        expect(await noWeth.balanceOf(user.address)).to.equal(0n);
        expect(await weth.balanceOf(user.address)).to.equal(wethStart);
    });

    it("2b. splitPosition / mergePositions round trip for USDS collateral", async function () {
        const amount = ethers.parseEther("10");
        const usdsStart = await usds.balanceOf(user.address);

        await usds.approve(FUTARCHY_ROUTER, ethers.MaxUint256);
        await router.splitPosition(PROPOSAL, USDS, amount);
        expect(await yesUsds.balanceOf(user.address)).to.equal(amount);
        expect(await noUsds.balanceOf(user.address)).to.equal(amount);
        expect(await usds.balanceOf(user.address)).to.equal(usdsStart - amount);

        await yesUsds.approve(FUTARCHY_ROUTER, ethers.MaxUint256);
        await noUsds.approve(FUTARCHY_ROUTER, ethers.MaxUint256);
        await router.mergePositions(PROPOSAL, USDS, amount);
        expect(await yesUsds.balanceOf(user.address)).to.equal(0n);
        expect(await noUsds.balanceOf(user.address)).to.equal(0n);
        expect(await usds.balanceOf(user.address)).to.equal(usdsStart);
    });

    async function runArb(direction, name) {
        const borrow = ethers.parseEther("0.0002");  // ~$0.4 - pools only hold a few $
        const subsidy = ethers.parseEther("0.0005"); // covers fees + price impact
        const arbAddr = await arb.getAddress();

        // Pre-fund subsidy so the atomic repay check passes on aligned prices
        await weth.transfer(arbAddr, subsidy);
        const adminStart = await weth.balanceOf(user.address);

        // Simulate first to capture the returned result struct
        const sim = await arb.executeArbitrage.staticCall(borrow, direction, 0, 0, { gasLimit: 3000000n });
        expect(sim.success).to.equal(true);
        expect(sim.borrowAmount).to.equal(borrow);

        // Execute for real on the fork
        const tx = await arb.executeArbitrage(borrow, direction, 0, 0, { gasLimit: 3000000n });
        await tx.wait();

        // Coherent balances:
        // - all WETH swept out of the contract (repaid + profit to admin)
        expect(await weth.balanceOf(arbAddr)).to.equal(0n);
        // - admin got back subsidy minus round-trip cost; cost must be < subsidy
        const adminEnd = await weth.balanceOf(user.address);
        const profit = adminEnd - adminStart; // = subsidy - roundTripCost
        expect(profit > 0n, "profit > 0").to.equal(true);
        // Net round-trip cost after subsidy. Negative = genuine arb profit (e.g. the
        // second direction profits from the price move the first test caused).
        const cost = subsidy - profit;
        console.log(`      ${name}: borrowed 0.0002 WETH, net round-trip cost ${ethers.formatEther(cost)} WETH` +
            (cost < 0n ? " (net PROFIT beyond subsidy)" : ""));
        // - only small unmerged conditional dust may remain (< 10% of borrow)
        const dustBound = borrow / 10n;
        expect((await yesWeth.balanceOf(arbAddr)) < dustBound, "YES_WETH dust").to.equal(true);
        expect((await noWeth.balanceOf(arbAddr)) < dustBound, "NO_WETH dust").to.equal(true);
        // conditional USDS dust bound: 10% of borrow value at ~2500 USDS/WETH max
        const usdsDustBound = (borrow / 10n) * 2500n;
        expect((await yesUsds.balanceOf(arbAddr)) < usdsDustBound, "YES_USDS dust").to.equal(true);
        expect((await noUsds.balanceOf(arbAddr)) < usdsDustBound, "NO_USDS dust").to.equal(true);
        expect((await usds.balanceOf(arbAddr)) < ethers.parseEther("0.01"), "USDS dust").to.equal(true);
        expect((await usdc.balanceOf(arbAddr)) < 10000n, "USDC dust").to.equal(true); // < 0.01 USDC
    }

    it("3a. full flash-arb SPOT_SPLIT end-to-end on real pools", async function () {
        const Arb = await ethers.getContractFactory("ETHFlashArbitrageV1");
        arb = await Arb.deploy();
        await arb.waitForDeployment();
        await runArb(SPOT_SPLIT, "SPOT_SPLIT");
    });

    it("3b. full flash-arb MERGE_SPOT end-to-end on real pools", async function () {
        await runArb(MERGE_SPOT, "MERGE_SPOT");
    });

    it("4. executeArbitrage is admin-gated", async function () {
        const [, stranger] = await ethers.getSigners();
        let reverted = false;
        try {
            await arb.connect(stranger).executeArbitrage.staticCall(ethers.parseEther("0.0001"), SPOT_SPLIT, 0, 0);
        } catch (e) {
            reverted = true;
            expect(e.message).to.include("Admin only");
        }
        expect(reverted, "non-admin call must revert").to.equal(true);
    });
});
