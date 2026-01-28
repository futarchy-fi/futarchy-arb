require("@nomicfoundation/hardhat-ethers");
require("@nomicfoundation/hardhat-verify");
require("dotenv").config();

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
    solidity: {
        version: "0.8.24",
        settings: {
            optimizer: {
                enabled: true,
                runs: 200
            },
            viaIR: true
        }
    },
    networks: {
        hardhat: {
            forking: {
                url: process.env.RPC_URL || "https://rpc.gnosischain.com",
                enabled: true
            }
        },
        gnosis: {
            url: process.env.GNOSIS_RPC_URL || "https://rpc.gnosischain.com",
            accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
            chainId: 100,
            gasPrice: "auto"
        },
        mainnet: {
            url: process.env.RPC_URL || "https://ethereum.publicnode.com",
            accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
            chainId: 1,
            gasPrice: "auto"
        }
    },
    etherscan: {
        apiKey: process.env.ETHERSCAN_API_KEY || ""
    },
    sourcify: {
        enabled: false  // Disable Sourcify to force Etherscan verification
    },
    paths: {
        sources: "./contracts",
        tests: "./test",
        cache: "./cache",
        artifacts: "./artifacts"
    }
};
