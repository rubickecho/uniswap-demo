import fs from 'fs/promises';
import path from 'path';
import fetchUniswapTokens from '../src/fetchTokenList.js';
async function updateTokenList() {
  try {
    // 获取代币数据
    const tokens = await fetchUniswapTokens();

    // 添加自定义验证
    const validatedTokens = tokens.filter(token => {
      return token.address && token.decimals && token.name;
    });

    // 添加额外信息
    const enrichedTokens = await Promise.all(
      validatedTokens.map(async token => {
        // 获取代币图标
        const img = `https://basescan.org/token/images/${token.address}.png`;

        return {
          ...token,
          img,
          // 可以添加更多信息，如市值、流动性等
        };
      })
    );

    // 写入文件
    await fs.writeFile(
      path.join(process.cwd(), 'src/autoTokenList.json'),
      JSON.stringify(enrichedTokens, null, 2)
    );

    console.log('代币列表更新成功！');
  } catch (error) {
    console.error('更新代币列表失败:', error);
  }
}

updateTokenList();
