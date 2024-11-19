import React, { useState, useEffect } from "react";
import { Input, Popover, Radio, Modal, message } from "antd";
import {
	ArrowDownOutlined,
	DownOutlined,
	SettingOutlined,
} from "@ant-design/icons";
// import tokenList from "../tokenList.json";
import tokenList from "../autoTokenList.json";
import {
	Pool,
	Route,
	Trade,
	FeeAmount,
	SwapQuoter,
	SwapRouter,
	TickMath,
	TICK_SPACINGS,
	TickListDataProvider,
	nearestUsableTick,
} from "@uniswap/v3-sdk";
import { Token, CurrencyAmount, TradeType } from "@uniswap/sdk-core";
// import {
// 	ChainId,
// 	Token,
// 	CurrencyAmount,
// 	TradeType
// } from "@uniswap/sdk-core";
import { ethers } from "ethers";
import {
	erc20,
	infura_connection_base,
	infura_connection_testnet,
	pool_abi,
	router_v3_api,
} from "../resource";
import {
	useAccount,
	useWriteContract,
	useReadContract,
	useChainId,
} from "wagmi";
import { ROUTER_ADDRESSES } from "../contracts";

// 缓存 tick 数据
const ticksCache = new Map();

// 添加所有可能的费率常量
const FEE_AMOUNTS = [
	// FeeAmount.LOWEST,  // 0.01%
	FeeAmount.LOW, // 0.05%
	//   FeeAmount.MEDIUM,  // 0.3%
	// FeeAmount.HIGH     // 1%
];

// 1. 首先定义 ERC20 代币的标准 ABI
const ERC20_ABI = [
  // 查询余额
  {
    constant: true,
    inputs: [{ name: "_owner", type: "address" }],
    name: "balanceOf",
    outputs: [{ name: "balance", type: "uint256" }],
    type: "function"
  },
  // 查询授权额度
  {
    constant: true,
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" }
    ],
    name: "allowance",
    outputs: [{ name: "", type: "uint256" }],
    type: "function"
  },
  // 授权函数
  {
    constant: false,
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" }
    ],
    name: "approve",
    outputs: [{ name: "", type: "bool" }],
    type: "function"
  }
];

const ROUTER_ABI = [
	{
		inputs: [
			{
				components: [
					{
						internalType: "bytes",
						name: "path",
						type: "bytes",
					},
					{
						internalType: "address",
						name: "recipient",
						type: "address",
					},
					{
						internalType: "uint256",
						name: "deadline",
						type: "uint256",
					},
					{
						internalType: "uint256",
						name: "amountIn",
						type: "uint256",
					},
					{
						internalType: "uint256",
						name: "amountOutMinimum",
						type: "uint256",
					},
				],
				internalType: "struct ISwapRouter.ExactInputParams",
				name: "params",
				type: "tuple",
			},
		],
		name: "exactInput",
		outputs: [
			{
				internalType: "uint256",
				name: "amountOut",
				type: "uint256",
			},
		],
		stateMutability: "payable",
		type: "function",
	},
];

// WETH ABI
const WETH_ABI = [
  {
    "constant": false,
    "inputs": [],
    "name": "deposit",
    "outputs": [],
    "payable": true,
    "stateMutability": "payable",
    "type": "function"
  },
  {
    "constant": false,
    "inputs": [{"name": "wad", "type": "uint256"}],
    "name": "withdraw",
    "outputs": [],
    "payable": false,
    "stateMutability": "nonpayable",
    "type": "function"
  }
];

// 添加 encodePath 辅助函数
function encodePath(path, fees) {
	if (path.length != fees.length + 1) {
		throw new Error("path/fee lengths do not match");
	}

	// 确保地址格式正确
	const formattedPath = path.map((address) => {
		// 移除可能存在的空格
		address = address.trim();
		// 确保地址有 0x 前缀
		if (!address.startsWith("0x")) {
			address = "0x" + address;
		}
		// 确保地址长度为 42 (包含 0x)
		if (address.length !== 42) {
			throw new Error(`Invalid address length: ${address}`);
		}
		return address;
	});

	let encoded = "0x";
	for (let i = 0; i < fees.length; i++) {
		// 移除 0x 前缀并确保地址为小写
		const cleanAddress = formattedPath[i].toLowerCase().slice(2);
		encoded += cleanAddress;
		// 将费率转换为十六进制并填充到 3 字节 (6 位)
		const feeHex = fees[i].toString(16).padStart(6, "0");
		encoded += feeHex;
	}
	// 添加最后一个地址
	encoded += formattedPath[formattedPath.length - 1].toLowerCase().slice(2);

	console.log("Path details:", {
		originalPath: path,
		fees: fees,
		encodedPath: encoded,
	});

	return encoded;
}

// 获取 tick 范围的函数
function getTickRange(currentTick, tickSpacing) {
	// 获取最近的可用 tick
	const nearestTick = nearestUsableTick(currentTick, tickSpacing);

	// 计算范围 (当前 tick 上下各 10 个 tick spacing)
	const numTicksAround = 10;
	const minTick = nearestTick - tickSpacing * numTicksAround;
	const maxTick = nearestTick + tickSpacing * numTicksAround;

	return { minTick, maxTick, tickSpacing };
}

// 获取 Tick 数据的函数
async function getPoolTicks(poolContract, feeAmount) {
	try {
		// 1. 获取当前 tick
		const slot0 = await poolContract.slot0();
		const currentTick = slot0.tick;

		// 2. 获取 tick 范围
		const { minTick, maxTick, tickSpacing } = getTickRange(
			currentTick,
			TICK_SPACINGS[feeAmount]
		);

		console.log("Fetching ticks in range:", {
			currentTick,
			minTick,
			maxTick,
			tickSpacing,
		});

		// 3. 构建 tick 数组
		const tickPromises = [];
		for (let i = minTick; i <= maxTick; i += tickSpacing) {
			tickPromises.push(poolContract.ticks(i));
		}

		// 4. 并行获取所有 tick 数据
		const tickResults = await Promise.all(tickPromises);

		// 5. 处理结果
		const ticks = tickResults
			.map((tickData, i) => {
				const tick = minTick + i * tickSpacing;
				return {
					index: tick,
					liquidityNet: tickData.liquidityNet,
					liquidityGross: tickData.liquidityGross,
				};
			})
			.filter((tick) => tick.liquidityGross.gt(0)); // 只保留有流动性的 tick

		console.log(`Found ${ticks.length} initialized ticks`);
		return ticks;
	} catch (error) {
		console.error("Error fetching ticks:", error);
		throw error;
	}
}

function SwapV3() {
	// 获取当前网络
	const chainId = useChainId();
	console.log("当前网络: " + chainId);
	const [messageApi, contextHolder] = message.useMessage();
	const [slippage, setSlippage] = useState(2.5);
	const [tokenOneAmount, setTokenOneAmount] = useState(null);
	const [tokenTwoAmount, setTokenTwoAmount] = useState(null);

	//【1.代币信息获取阶段】初始化两个代币状态
	const [tokenOne, setTokenOne] = useState(tokenList[0]);
	const [tokenTwo, setTokenTwo] = useState(tokenList[1]);

	// 【1.代币信息获取阶段】初始化 Token 实例
	const [currentRoute, setCurrentRoute] = useState(null);
	const [currentTokenOneInstance, setCurrentTokenOneInstance] = useState(null);
	const [currentTokenTwoInstance, setCurrentTokenTwoInstance] = useState(null);

	const [isOpen, setIsOpen] = useState(false);
	const [changeToken, setChangeToken] = useState(1);
	const [prices, setPrices] = useState(null);
	const [txDetails, setTxDetails] = useState({
		to: null,
		data: null,
		value: null,
	});

	const { writeContract } = useWriteContract();
	// const { readContract } = useReadContract();
	const account = useAccount();
	const { data, sendTransaction } = {};

	const { isLoading, isSuccess } = {};

	const { data: balance } = useReadContract({
		address: tokenOne?.address,
		abi: [
			{
				constant: true,
				inputs: [{ name: "_owner", type: "address" }],
				name: "balanceOf",
				outputs: [{ name: "balance", type: "uint256" }],
				type: "function",
			},
		],
		functionName: "balanceOf",
		args: [account?.address],
		enabled: !!account?.address && !!tokenOne?.address,
	});

	function handleSlippageChange(e) {
		setSlippage(e.target.value);
	}

	function changeAmount(e) {
		setTokenOneAmount(e.target.value);
		if (e.target.value && prices) {
			setTokenTwoAmount((e.target.value * prices.ratio).toFixed(6));
		} else {
			setTokenTwoAmount(null);
		}
	}

	function switchTokens() {
		setPrices(null);
		setTokenOneAmount(null);
		setTokenTwoAmount(null);
		const one = tokenOne;
		const two = tokenTwo;
		setTokenOne(two);
		setTokenTwo(one);
		fetchPrices(two, one);
	}

	function openModal(asset) {
		setChangeToken(asset);
		setIsOpen(true);
	}

	function modifyToken(i) {
		setPrices(null);
		setTokenOneAmount(null);
		setTokenTwoAmount(null);
		if (changeToken === 1) {
			setTokenOne(tokenList[i]);
			fetchPrices(tokenList[i], tokenTwo);
		} else {
			setTokenTwo(tokenList[i]);
			fetchPrices(tokenOne, tokenList[i]);
		}
		setIsOpen(false);
	}

	// 添加合约地址验证
	const validateRouterAddress = (address) => {
		if (!ethers.utils.isAddress(address)) {
			messageApi.error("无效的路由合约地址");
			return false;
		}
		return true;
	};

	// 根据网络动态获取路由地址
	const getRouterAddress = () => {
		console.log("根据网络动态获取路由地址: " + chainId);
		if (!chainId) return null;

		switch (chainId) {
			case 8453: // Base
				return ROUTER_ADDRESSES.BASE;
			case 84531: // Base Testnet
				return ROUTER_ADDRESSES.BASE_TESTNET;
			case 11155111: // Sepolia
				return ROUTER_ADDRESSES.SEPOLIA;
			default:
				messageApi.error("不支持的网络");
				return null;
		}
	};

	const formatTokenAmount = (amount, decimals) => {
		// 将数字拆分成整数部分和小数部分
		const [integerPart, decimalPart = ""] = amount.split(".");

		// 组合整数和小数部分
		let combined = integerPart + decimalPart;

		// 计算需要填充的零的数量
		const paddingLength = decimals - decimalPart.length;

		// 如果需要填充零，则填充
		if (paddingLength > 0) {
			combined = combined.padEnd(combined.length + paddingLength, "0");
		} else if (paddingLength < 0) {
			// 如果小数部分长度超出，需要截取
			combined = combined.slice(0, paddingLength);
		}

		combined = combined.replace(/^0+/, "");

		console.log("amount: " + amount + ", result: " + combined);

		return combined;
	};

	// 2. 获取 provider 的辅助函数
	const getProvider = (needSigner = false) => {
		if (needSigner) {
			// 需要签名时使用钱包 provider
			if (!window.ethereum) {
				throw new Error("请安装 MetaMask 或其他钱包");
			}
			return new ethers.providers.Web3Provider(window.ethereum);
		} else {
			// 只读操作使用 RPC provider
			return new ethers.providers.JsonRpcProvider(
				chainId === 11155111
					? infura_connection_testnet
					: infura_connection_base
			);
		}
	};

	// 创建池子的函数
	async function createPool(tokenOneInstance, tokenTwoInstance) {
		try {
			for (const feeAmount of FEE_AMOUNTS) {
				try {
					// 1. 获取池子地址
					let poolAddress = Pool.getAddress(
						tokenOneInstance,
						tokenTwoInstance,
						feeAmount
					);
					console.log("getPoolAddress: " + poolAddress);
					// let poolAddress = getPool(tokenOne.address, tokenTwo.address, feeAmount);

					poolAddress = "0x224Cc4e5b50036108C1d862442365054600c260C";
					console.log(
						`Checking pool with fee ${feeAmount / 10000}%:`,
						poolAddress
					);

					// 2. 检查缓存
					if (ticksCache.has(poolAddress)) {
						console.log("Using cached tick data");
						const cachedData = ticksCache.get(poolAddress);
						return cachedData.pool;
					}

					// 3. 获取 provider
					const provider = getProvider(true);

					// 4. 验证合约存在
					const code = await provider.getCode(poolAddress);
					if (code === "0x") {
						console.log(`Pool does not exist for fee ${feeAmount / 10000}%`);
						continue;
					}

					// 5. 创建合约实例
					const poolContract = new ethers.Contract(
						poolAddress,
						pool_abi,
						provider
					);

					// 6. 获取池子状态
					const [slot0, liquidity] = await Promise.all([
						poolContract.slot0(),
						poolContract.liquidity(),
					]);

					// 7. 验证流动性
					if (liquidity.eq(0)) {
						console.log(`No liquidity in pool with fee ${feeAmount / 10000}%`);
						continue;
					}

					// 8. 获取 ticks 数据
					const ticks = await getPoolTicks(poolContract, feeAmount);
					if (!ticks || ticks.length === 0) {
						console.log(`No valid ticks found for fee ${feeAmount / 10000}%`);
						continue;
					}

					// 9. 创建 TickListDataProvider
					const tickDataProvider = new TickListDataProvider(
						ticks,
						TICK_SPACINGS[feeAmount]
					);

					// 10. 创建池子实例
					const pool = new Pool(
						tokenOneInstance,
						tokenTwoInstance,
						feeAmount,
						slot0.sqrtPriceX96.toString(),
						liquidity.toString(),
						slot0.tick,
						tickDataProvider
					);

					// 11. 缓存数据
					ticksCache.set(poolAddress, {
						pool,
						ticks,
						timestamp: Date.now(),
					});

					console.log(
						`Successfully created pool with fee ${feeAmount / 10000}%:`,
						{
							address: poolAddress,
							currentTick: slot0.tick,
							liquidity: liquidity.toString(),
							ticksCount: ticks.length,
						}
					);

					return pool;
				} catch (error) {
					console.error(`Error with fee ${feeAmount / 10000}%:`, error);
					continue;
				}
			}

			messageApi.error("未找到可用的流动性池");
			return null;
		} catch (error) {
			console.error("createPool error:", error);
			messageApi.error("创建流动性池失败");
			return null;
		}
	}

	// 【价格计算阶段】计算价格
	async function fetchPrices(tokenOne, tokenTwo) {
		try {
			console.log("tokenOne:", tokenOne);
			console.log("tokenTwo:", tokenTwo);
			console.log("chainId:", chainId);

			const tokenOneInstance = new Token(
				chainId,
				tokenOne.address,
				tokenOne.decimals
			);
			const tokenTwoInstance = new Token(
				chainId,
				tokenTwo.address,
				tokenTwo.decimals
			);

			// 创建池子实例
			const pool = await createPool(tokenOneInstance, tokenTwoInstance);
			if (!pool) {
				console.log("无法创建流动性池");
				setPrices(null);
				return;
			}

			// 尝试创建路由
			try {
				const route = new Route([pool], tokenOneInstance, tokenTwoInstance);

				// 保存实例以供后续使用
				setCurrentTokenOneInstance(tokenOneInstance);
				setCurrentTokenTwoInstance(tokenTwoInstance);
				setCurrentRoute(route);

				// 计算价格
				const tokenOnePrice = route.midPrice.toSignificant(6);
				const tokenTwoPrice = route.midPrice.invert().toSignificant(6);
				const ratio = tokenOnePrice;

				console.log(
					`计算价格 ${tokenOne.ticker}: ${tokenOnePrice}, ${tokenTwo.ticker}: ${tokenTwoPrice}, Ratio: ${ratio}`
				);

				setPrices({
					tokenOne: tokenOnePrice,
					tokenTwo: tokenTwoPrice,
					ratio: ratio,
				});
			} catch (error) {
				console.error("Route creation error:", error);
				messageApi.error("无法计算交易路径");
				setPrices(null);
			}
		} catch (error) {
			console.error("fetchPrices error:", error);
			messageApi.error("获取价格失败");
			setPrices(null);
		}
	}

	// 计算价格影响
	// 价格影响的概念：价格影响越大，交易对的价格变动越大，交易对的价格变动越大，交易对的价格变动越大，交易对的价格变动越大，交易对的价格变动越大
	// 1. 保护用户利益
	// 2. 防止价格操纵
	// 3. 确保交易对的价格变动在可接受范围内
	function calculatePriceImpact(trade) {
		// 获取交易前后的价格变化
		const priceImpact = trade.priceImpact.toSignificant(2);
		console.log("价格影响: " + priceImpact);

		// 根据价格影响程度给出警告
		if (priceImpact > 5) {
			messageApi.warning(
				`大���交易警告：此笔交易将导致 ${priceImpact}% 的价格影响`
			);
		}

		return priceImpact;
	}

	// 2. 检查授权状态的函数
	async function checkAllowance(tokenAddress, ownerAddress, spenderAddress) {
		try {
			// const provider = new ethers.providers.JsonRpcProvider(
			// 	chainId === 11155111 ? infura_connection_testnet : infura_connection_base
			// );
			const provider = getProvider(true);

			const tokenContract = new ethers.Contract(
				tokenAddress,
				ERC20_ABI,
				provider
			);
			const allowance = await tokenContract.allowance(
				ownerAddress,
				spenderAddress
			);

			console.log("Current allowance:", allowance.toString());
			return allowance;
		} catch (error) {
			console.error("检查授权失败:", error);
			throw error;
		}
	}

	// 【3.交易准备阶段】授权代币
	// 为什么需要授权？
	// 	安全性考虑
	// 	* 在以太坊（和 Base）上，代币遵循 ERC20 标准
	// 	* 用户必须先授权（approve）其他合约使用自己的代币
	// 	* 这是一种安全机制，防止恶意合约随意转移用户的代币
	// 交易流程
	// 	* 第一步：用户授权 Router 合约使用代币
	// 	* 第二步：Router 合约才能执行实际的代币交换
	// 使用场景
	// 	* 在用户进行代币交换前，需要先调用此函数
	//  * 授权成功后，才能进行实际的代币交换操作
	//  * 这是一个独立的交易，需要用户支付 gas 费用

	async function approveToken(tokenAddress, spenderAddress, amount) {
		try {
			console.log("开始授权流程");
			console.log("Token address:", tokenAddress);
			console.log("Spender address:", spenderAddress);
			console.log("Amount:", amount);

			// 验证地址
			if (!ethers.utils.isAddress(tokenAddress)) {
				throw new Error("无效的代币地址");
			}
			if (!ethers.utils.isAddress(spenderAddress)) {
				throw new Error("无效的 spender 地址");
			}

			// 获取 provider 和 signer
			const provider = getProvider(true);
			// 注意：这里需要用户连接钱包
			const signer = await provider.getSigner(account.address);

			// 创建代币合约实例
			const tokenContract = new ethers.Contract(
				tokenAddress,
				ERC20_ABI,
				signer
			);

			// 检查当前授权额度
			console.log("授权状态检查：");
			const currentAllowance = await checkAllowance(
				tokenAddress,
				account.address,
				spenderAddress
			);
			// 添加更友好的日志输出
			console.log(
				"- 当前授权额度：",
				ethers.utils.formatUnits(currentAllowance, 18)
			);
			console.log("- 需要授权额度：", ethers.utils.formatUnits(amount, 18));

			// 如果已经有足够的授权额度，直接返回
			if (currentAllowance.gte(amount)) {
				console.log("已有足够的授权额度");
				return true;
			}

			console.log("⚠️ 需要进行新的授权");
			messageApi.info("正在请求授权...");

			// 发送授权交易
			return new Promise(async (resolve, reject) => {
				try {
					// 发送交易
					const tx = await tokenContract.approve(spenderAddress, amount);
					console.log("授权交易已发送:", tx.hash);

					messageApi.info({
						content: "授权交易已发送，等待确认...",
						duration: 5,
					});

					// 等待交易确认
					const receipt = await tx.wait(1); // 等待 1 个确认
					console.log("交易已确认:", receipt);

					// 验证新的授权额度
					const newAllowance = await checkAllowance(
						tokenAddress,
						account.address,
						spenderAddress
					);

					if (newAllowance.gte(amount)) {
						messageApi.success("授权成功");
						resolve(true);
					} else {
						throw new Error("授权额度验证失败");
					}
				} catch (error) {
					console.error("授权失败:", error);
					messageApi.error(error.message || "授权失败");
					reject(error);
				}
			});
		} catch (error) {
			console.error("授权过程出错:", error);
			messageApi.error(error.message || "授权过程出错");
			throw error;
		}
	}

	// 2. 使用 ethers 执行交易的函数
	async function executeSwap(routerAddress, swapParams) {
		try {
			// 1. 参数验证
			if (!routerAddress || !ethers.utils.isAddress(routerAddress)) {
				throw new Error("无效的路由合约地址");
			}

			if (!swapParams || !swapParams.path || !swapParams.amountIn) {
				throw new Error("无效的交易参数");
			}

			console.log("交易参数:", {
				routerAddress,
				path: swapParams.path,
				recipient: swapParams.recipient,
				deadline: new Date(swapParams.deadline * 1000).toLocaleString(),
				amountIn: swapParams.amountIn,
				amountOutMinimum: swapParams.amountOutMinimum,
			});

			// 2. 获取 provider 和 signer
			// 添加参数详细检查
			const provider = new ethers.providers.Web3Provider(window.ethereum);
			const signer = await provider.getSigner();
			const routerContract = new ethers.Contract(
				routerAddress,
				ROUTER_ABI,
				signer
			);

			// 解码路径参数
			console.log("Path 解码:", {
				rawPath: swapParams.path,
				hexLength: swapParams.path.length,
				// 尝试解析路径中的地址
				addresses: swapParams.path.match(/.{1,40}/g),
			});

			// 检查代币余额
			const tokenContract = new ethers.Contract(
				tokenOne.address,
				ERC20_ABI,
				provider
			);
			const balance = await tokenContract.balanceOf(account.address);
			console.log("代币余额检查:", {
				balance: ethers.utils.formatUnits(balance, tokenOne.decimals),
				required: ethers.utils.formatUnits(
					swapParams.amountIn,
					tokenOne.decimals
				),
			});

			// 检查授权状态
			const allowance = await tokenContract.allowance(
				account.address,
				routerAddress
			);
			console.log("授权状态检查:", {
				allowance: ethers.utils.formatUnits(allowance, tokenOne.decimals),
				required: ethers.utils.formatUnits(
					swapParams.amountIn,
					tokenOne.decimals
				),
			});

			// 构建并打印完整的调用数据
			const callData = routerContract.interface.encodeFunctionData(
				"exactInput",
				[swapParams]
			);
			console.log("编码后的调用数据:", {
				callData,
				decodedParams: routerContract.interface.decodeFunctionData(
					"exactInput",
					callData
				),
			});

			// 尝试模拟交易
			// try {
			// 	const result = await provider.call({
			// 		to: routerAddress,
			// 		data: callData,
			// 		from: account.address,
			// 	});
			// 	console.log("模拟交易成功:", result);
			// } catch (error) {
			// 	console.error("模拟交易失败:", error);
			// 	// 尝试解码错误
			// 	if (error.data) {
			// 		try {
			// 			const iface = new ethers.utils.Interface([
			// 				"error InsufficientInputAmount()",
			// 				"error InvalidPath()",
			// 				"error TooLittleReceived()",
			// 				"error DeadlineExpired()",
			// 				// 添加其他可能的错误
			// 			]);
			// 			const decodedError = iface.parseError(error.data);
			// 			throw new Error(`合约错误: ${decodedError.name}`);
			// 		} catch (e) {
			// 			console.error("无法解码错误:", e);
			// 		}
			// 	}
			// 	throw new Error("交易模拟失败: " + (error.reason || error.message));
			// }

			// 5. 估算 gas
			// let gasEstimate;
			// try {
			// 	gasEstimate = await routerContract.estimateGas.exactInput(swapParams);
			// 	console.log("预估 gas:", gasEstimate.toString());
			// } catch (error) {
			// 	console.error("Gas 估算失败:", error);
			// 	// 尝试解码错误
			// 	if (error.data) {
			// 		const iface = new ethers.utils.Interface(ROUTER_ABI);
			// 		try {
			// 			const decoded = iface.parseError(error.data);
			// 			throw new Error(`合约错误: ${decoded.name}`);
			// 		} catch (e) {
			// 			// 如果解码失败，抛出原始错误
			// 			throw error;
			// 		}
			// 	}
			// 	throw new Error("无法估算 gas 费用");
			// }

			// // 6. 获取当前 gas 价格
			// const gasPrice = await provider.getGasPrice();
			// console.log(
			// 	"当前 gas 价格:",
			// 	ethers.utils.formatUnits(gasPrice, "gwei"),
			// 	"gwei"
			// );

			// 估算 gas
			// const gasEstimate = await routerContract.estimateGas.exactInput(
			// 	swapParams,
			// 	{ value: 0 }
			// );

			// console.log("Estimated gas:", gasEstimate.toString());

			// 增加 20% 的 gas 限制作为缓冲
			// const gasLimit = gasEstimate.mul(120).div(100);

			// 发送交易
			const tx = await routerContract.exactInput(
				swapParams,
				{
					gasLimit: 50000,
					value: 0
				}
			);

			console.log("Transaction sent:", tx.hash);
			messageApi.info("交易已发送，等待确认...");

			// 等待交易确认
			const receipt = await tx.wait(1);

			// 检查交易状态
			if (receipt.status === 0) {
				throw new Error("Transaction failed");
			}

			console.log("Transaction confirmed:", receipt);
			return receipt;

			// // 7. 构建交易对象
			// const txRequest = {
			// 	to: routerAddress,
			// 	from: await signer.getAddress(),
			// 	data: routerContract.interface.encodeFunctionData("exactInput", [
			// 		swapParams,
			// 	]),
			// 	gasLimit: gasEstimate.mul(120).div(100), // 增加 20% 的 gas 限制
			// 	gasPrice: gasPrice,
			// 	value: 0, // 如果不是 ETH 交易，设为 0
			// };

			// console.log("交易请求:", {
			// 	...txRequest,
			// 	gasLimit: txRequest.gasLimit.toString(),
			// 	gasPrice: txRequest.gasPrice.toString(),
			// });

			// // 8. 发送交易
			// let tx;
			// try {
			// 	tx = await signer.sendTransaction(txRequest);
			// 	console.log("交易已发送:", tx.hash);
			// } catch (error) {
			// 	console.error("发送交易失败:", error);
			// 	throw new Error("发送交易失败: " + (error.reason || error.message));
			// }

			// // 9. 等待交易确认
			// console.log("等待交易确认...");
			// const receipt = await tx.wait(1);

			// // 10. 验证交易结果
			// if (receipt.status === 0) {
			// 	throw new Error("交易执行失败");
			// }

			// console.log("交易成功:", {
			// 	transactionHash: receipt.transactionHash,
			// 	blockNumber: receipt.blockNumber,
			// 	gasUsed: receipt.gasUsed.toString(),
			// 	effectiveGasPrice: receipt.effectiveGasPrice.toString(),
			// });

			// return receipt;
		} catch (error) {
			console.error("Swap execution error:", error);

			// 错误分类处理
			let errorMessage = "交易执行失败";
			if (error.code === "UNPREDICTABLE_GAS_LIMIT") {
				errorMessage = "无法估算 gas 限制，请检查交易参数";
			} else if (error.code === "INSUFFICIENT_FUNDS") {
				errorMessage = "账户余额不足以支付 gas 费用";
			} else if (error.message.includes("execution reverted")) {
				errorMessage = "交易被回滚: " + (error.reason || error.message);
			} else if (error.message.includes("user rejected")) {
				errorMessage = "用户取消了交易";
			}

			throw new Error(errorMessage);
		}
	}

	// 【3.交易准备阶段】准备交易
	async function fetchDexSwap() {
		try {
			const routerAddress = getRouterAddress();
			if (!routerAddress || !validateRouterAddress(routerAddress)) {
				throw new Error("无效的路由合约地址");
			}

			const amountIn = formatTokenAmount(tokenOneAmount, tokenOne.decimals);
			console.log("交易金额:", amountIn);

			try {
				await approveToken(tokenOne.address, routerAddress, amountIn); // 修改这里，传入 routerAddress
			} catch (error) {
				console.error("授权失败，终止交易");
			}

			// 计算最小获得量(考虑滑点)
			const tokenTwoOut = (Number(tokenTwoAmount) * (100 - slippage)) / 100;
			const amountOutMin = formatTokenAmount(
				tokenTwoOut.toString(),
				tokenTwo.decimals
			);

			// 构建交易路径
			const path = encodePath(
				[tokenOne.address, tokenTwo.address],
				[FeeAmount.LOW]
			);

			// 构建交易路径
			console.log("Encoded path:", path);

			const swapParams = {
				path,
				recipient: account.address,
				deadline: Math.floor(Date.now() / 1000) + 60 * 20,
				amountIn,
				amountOutMinimum: amountOutMin,
			};
			console.log("swapParams >>>> ", swapParams);

			console.log("完整交易参数:", {
				tokenOne: {
					address: tokenOne.address,
					decimals: tokenOne.decimals,
					amount: tokenOneAmount,
				},
				tokenTwo: {
					address: tokenTwo.address,
					decimals: tokenTwo.decimals,
					amount: tokenTwoAmount,
					minimumAmount: tokenTwoOut,
				},
				swapParams,
				encodedPath: path,
			});

			try {
				// 执行交易
				const receipt = await executeSwap(routerAddress, swapParams);

				// 交易成功
				messageApi.success({
					content: "交易成功！",
					duration: 5,
				});

				// 更新交易详情
				setTxDetails({
					to: receipt.to,
					from: receipt.from,
					hash: receipt.transactionHash,
					confirmation: receipt.confirmations,
					success: true,
				});

				// 可以在这里添加其他成功后的操作，比如刷新余额等
			} catch (error) {
				console.error("交易执行失败:", error);
				messageApi.error({
					content: `交易失败: ${error.message}`,
					duration: 5,
				});
			}
		} catch (error) {
			messageApi.error("交易执行失败");
			console.error(error);
		}
	}

	useEffect(() => {
		// 如果没有链接钱包，则不进行价格计算
		// if (!account.isConnected) {
		// 	console.log("没有链接钱包");
		// 	return;
		// };
		fetchPrices(tokenList[0], tokenList[1]);
	}, []);

	useEffect(() => {
		if (txDetails.to && account.isConnected) {
			sendTransaction();
		}
	}, [txDetails]);

	useEffect(() => {
		messageApi.destroy();

		if (isLoading) {
			messageApi.open({
				type: "loading",
				content: "Transaction is Pending...",
				duration: 0,
			});
		}
	}, [isLoading]);

	useEffect(() => {
		messageApi.destroy();
		if (isSuccess) {
			messageApi.open({
				type: "success",
				content: "Transaction Successful",
				duration: 1.5,
			});
		} else if (txDetails.to) {
			messageApi.open({
				type: "error",
				content: "Transaction Failed",
				duration: 1.5,
			});
		}
	}, [isSuccess]);

	const settings = (
		<>
			<div>Slippage Tolerance</div>
			<div>
				<Radio.Group value={slippage} onChange={handleSlippageChange}>
					<Radio.Button value={0.5}>0.5%</Radio.Button>
					<Radio.Button value={2.5}>2.5%</Radio.Button>
					<Radio.Button value={5}>5.0%</Radio.Button>
				</Radio.Group>
			</div>
		</>
	);

	// 清理缓存的函数
	function clearTicksCache(maxAge = 5 * 60 * 1000) {
		// 默认 5 分钟
		const now = Date.now();
		for (const [address, data] of ticksCache.entries()) {
			if (now - data.timestamp > maxAge) {
				ticksCache.delete(address);
			}
		}
	}

	// 定期清理缓存
	useEffect(() => {
		const interval = setInterval(() => clearTicksCache(), 5 * 60 * 1000);
		return () => clearInterval(interval);
	}, []);

	// 添加 wrap ETH 函数
async function wrapETH(amount) {
  try {
			const provider = new ethers.providers.Web3Provider(window.ethereum);
			const signer = await provider.getSigner();

			// WETH 合约地址 (Sepolia)
			// const WETH_ADDRESS = "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9";  // 请确认这是正确的 Sepolia WETH 地址

			const wethContract = new ethers.Contract(
				tokenOne.address,
				WETH_ABI,
				signer
			);

			// 将 ETH 数量转换为 Wei
			const amountInWei = ethers.utils.parseEther(amount);

			console.log("Wrapping ETH:", {
				amount,
				amountInWei: amountInWei.toString()
			});

			// 调用 deposit 函数并发送 ETH
			const tx = await wethContract.deposit({
				value: amountInWei
			});

			messageApi.info("正在将 ETH 转换为 WETH...");

			// 等待交易确认
			const receipt = await tx.wait();

			if (receipt.status === 1) {
				messageApi.success("成功将 ETH 转换为 WETH!");
				// 刷新余额
				// fetchBalance();
			} else {
				throw new Error("交易失败");
			}

			return receipt;
		} catch (error) {
			console.error("Wrap ETH failed:", error);
			messageApi.error("转换失败: " + error.message);
			throw error;
		}
	}

	return (
		<>
			{contextHolder}
			<Modal
				open={isOpen}
				footer={null}
				onCancel={() => setIsOpen(false)}
				title="Select a token"
			>
				<div className="modalContent">
					{tokenList?.map((e, i) => {
						return (
							<div
								className="tokenChoice"
								key={i}
								onClick={() => modifyToken(i)}
							>
								<img src={e.img} alt={e.ticker} className="tokenLogo" />
								<div className="tokenChoiceNames">
									<div className="tokenName">{e.name}</div>
									<div className="tokenTicker">{e.ticker}</div>
								</div>
							</div>
						);
					})}
				</div>
			</Modal>
			<div className="tradeBox">
				<div className="tradeBoxHeader">
					<h4>Swap</h4>
					<Popover
						content={settings}
						title="Settings"
						trigger="click"
						placement="bottomRight"
					>
						<SettingOutlined className="cog" />
					</Popover>
				</div>
				<div className="inputs">
					<Input
						placeholder="0"
						value={tokenOneAmount}
						onChange={changeAmount}
						disabled={!prices}
					/>
					<Input placeholder="0" value={tokenTwoAmount} disabled={true} />
					<div className="switchButton" onClick={switchTokens}>
						<ArrowDownOutlined className="switchArrow" />
					</div>
					<div className="assetOne" onClick={() => openModal(1)}>
						<img src={tokenOne.img} alt="assetOneLogo" className="assetLogo" />
						{tokenOne.ticker}
						<DownOutlined />
					</div>
					<div className="assetTwo" onClick={() => openModal(2)}>
						<img src={tokenTwo.img} alt="assetOneLogo" className="assetLogo" />
						{tokenTwo.ticker}
						<DownOutlined />
					</div>
				</div>
				<div
					className="swapButton"
					disabled={!tokenOneAmount || !account.isConnected}
					onClick={fetchDexSwap}
				>
					Swap
				</div>
			</div>
			<div>
					{/* 如果选择的是 WETH 且 WETH 余额不足，显示 Wrap 按钮 */}
					{tokenOne?.address.toLowerCase() === "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14".toLowerCase() &&
					(
						<div
						style={{ marginTop: "10px" }}
						className="swapButton"
						onClick={() => wrapETH(tokenOneAmount)}
					>
							将 {tokenOneAmount} ETH 转换为 WETH
					</div>
					)}
			</div>
		</>
	);
}

export default SwapV3;
