require("@nomicfoundation/hardhat-toolbox");
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
            url: process.env.RPC_URL || "https://rpc.gnosischain.com",
            accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
            chainId: 100,
            gasPrice: "auto"
        }
    },
    etherscan: {
        apiKey: process.env.GNOSISSCAN_API_KEY || "",
        customChains: [
            {
                network: "gnosis",
                chainId: 100,
                urls: {
                    apiURL: "https://api.gnosisscan.io/api",
                    browserURL: "https://gnosisscan.io"
                }
            }
        ]
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
