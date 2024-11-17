// export declare enum ChainId {
// 	MAINNET = 1,
// 	GOERLI = 5,
// 	SEPOLIA = 11155111,
// 	OPTIMISM = 10,
// 	OPTIMISM_GOERLI = 420,
// 	OPTIMISM_SEPOLIA = 11155420,
// 	ARBITRUM_ONE = 42161,
// 	ARBITRUM_GOERLI = 421613,
// 	ARBITRUM_SEPOLIA = 421614,
// 	POLYGON = 137,
// 	POLYGON_MUMBAI = 80001,
// 	CELO = 42220,
// 	CELO_ALFAJORES = 44787,
// 	GNOSIS = 100,
// 	MOONBEAM = 1284,
// 	BNB = 56,
// 	AVALANCHE = 43114,
// 	BASE_GOERLI = 84531,
// 	BASE = 8453,
// 	ZORA = 7777777,
// 	ZORA_SEPOLIA = 999999999,
// 	ROOTSTOCK = 30,
// 	BLAST = 81457
// }

async function fetchUniswapTokens() {
  try {
    // 获取 Uniswap 默认代币列表
    const response = await fetch('https://tokens.uniswap.org');
    const data = await response.json();

		// 过滤出 SEPOLIA 网络的代币
		const baseTokens = data.tokens.filter(token => token.chainId === 11155111);

    // 格式化数据
    return baseTokens.map(token => ({
      ticker: token.symbol,
      img: token.logoURI,
      name: token.name,
      address: token.address,
      decimals: token.decimals
    }));
  } catch (error) {
    console.error('获取 Uniswap 代币列表失败:', error);
    return [];
  }
}

export default fetchUniswapTokens;
