const { ethers } = require("hardhat");

const VAULT = "0xba12222222228d8ba445958a75a0704d566bf2c8";
const GNO = "0x9c58bacc331c9aa871afd802db6379a98e80cedb";
const WXDAI = "0xe91d153e0b41518a2ce8dd3d7944fa863463a97d";
const USDC = "0xddafbb505ad214d7b80b1f830fccc89b60fb7a83";
const SDAI = "0xaf204776c7245bf4147c2612bf6e5972ee483701";

// Pool IDs
const GNO_WXDAI = "0x8189c4c96826d016a99986394103dfa9ae41e7ee0002000000000000000000aa";
const WXDAI_USDC = "0x2086f52651837600180de173b09470f54ef7491000000000000000000000004f";
const USDC_SDAI = "0x7644fa5d0ea14fcf3e813fdf93ca9544f8567655000000000000000000000066";

async function main() {
    console.log("🧪 Verifying Balancer V2 Swap Logic (GNO -> sDAI)\n");

    const [signer] = await ethers.getSigners();
    console.log(`User: ${signer.address}`);

    const vault = await ethers.getContractAt("IBalancerV2Vault", VAULT, signer);
    const gnoToken = await ethers.getContractAt("IERC20", GNO, signer);

    // 1. Approve
    const amount = ethers.parseEther("0.01"); // 0.01 GNO
    await gnoToken.approve(VAULT, amount);
    console.log(`✅ Approved ${ethers.formatEther(amount)} GNO`);

    // 2. Prepare Swap
    const assets = [GNO, WXDAI, USDC, SDAI];

    const swaps = [
        {
            poolId: GNO_WXDAI,
            assetInIndex: 0,
            assetOutIndex: 1,
            amount: amount,
            userData: "0x"
        },
        {
            poolId: WXDAI_USDC,
            assetInIndex: 1,
            assetOutIndex: 2,
            amount: 0, // 0 for multihop
            userData: "0x"
        },
        {
            poolId: USDC_SDAI,
            assetInIndex: 2,
            assetOutIndex: 3,
            amount: 0,
            userData: "0x"
        }
    ];

    const funds = {
        sender: signer.address,
        fromInternalBalance: false,
        recipient: signer.address,
        toInternalBalance: false
    };

    // Limits
    // Input: positive, Output: negative (min amount)
    const MAX_INT256 = 2n ** 255n - 1n; // Approximating positive max
    const limits = [
        MAX_INT256, // GNO in (allow anything up to max)
        MAX_INT256, // WXDAI (allow anything)
        MAX_INT256, // USDC (allow anything)
        MAX_INT256  // sDAI out (accept anything; delta will be negative, which is <= MAX)
    ];
    // NOTE: ethers uses BigInt. 
    // -2n**255n is roughly min int256.

    console.log(`\n🔄 Attempting batchSwap (Static Call)...`);

    try {
        const deltas = await vault.batchSwap.staticCall(
            0, // GIVEN_IN
            swaps,
            assets,
            funds,
            limits,
            Math.floor(Date.now() / 1000) + 3600
        );

        console.log(`✅ Swap SUCCEEDED!`);
        console.log("   Deltas:", deltas.map(d => d.toString()));
        console.log(`   GNO Spent: ${deltas[0]}`);
        console.log(`   sDAI Recv: ${-deltas[3]}`); // Negative delta = receive

    } catch (e) {
        console.log(`❌ Swap FAILED:`);
        if (e.data) {
            try {
                const reason = ethers.toUtf8String("0x" + e.data.slice(138));
                console.log("   Reason:", reason);
            } catch {
                console.log("   Data:", e.data);
            }
        } else {
            console.log(e.reason || e.message);
        }
    }
}

main().catch(console.error);
