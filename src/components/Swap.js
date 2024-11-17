import React, { useState, useEffect } from "react";
import { Input, Popover, Radio, Modal, message } from "antd";
import {
	ArrowDownOutlined,
	DownOutlined,
	SettingOutlined,
} from "@ant-design/icons";
// import tokenList from "../tokenList.json";
import tokenList from "../autoTokenList.json";
import { Route, Pair, Trade } from "@uniswap/v2-sdk";
import {
	ChainId,
	Token,
	CurrencyAmount,
	TradeType
} from "@uniswap/sdk-core";
import { ethers } from "ethers";
import { infura_connection_base, pair_abi, router_abi } from "../resource";
import { useAccount, useWriteContract, useReadContract, useChainId } from "wagmi";
import { ROUTER_ADDRESSES } from "../contracts";

function Swap() {
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
    messageApi.error('无效的路由合约地址');
    return false;
  }
  return true;
};

	// 根据网络动态获取路由地址
	const getRouterAddress = () => {
		console.log("根据网络动态获取路由地址: " + chainId);
		if (!chainId) return null;

		switch (chainId) {
			case 8453:  // Base
				return ROUTER_ADDRESSES.BASE;
			case 84531: // Base Testnet
				return ROUTER_ADDRESSES.BASE_TESTNET;
			case 11155111: // Sepolia
				return ROUTER_ADDRESSES.SEPOLIA;
			default:
				messageApi.error('不支持的网络');
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

	// 【1.代币信息获取阶段】创建交易对实例
	async function createPair(tokenOneInstance, tokenTwoInstance) {
		try {
			// 获取 pair 地址
			const pairAddress = Pair.getAddress(tokenOneInstance, tokenTwoInstance);
			// router v2 02:  0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D
			// router v2 02 base:  0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24

			// Setup provider, import necessary ABI ...
			// 创建一个 JSON-RPC Provider 实例来连接 Base 网络
			// 通过 infura_connection_base 这个 RPC URL 来访问区块链节点
			// 这个 provider 对象用于后续与区块链交互,比如读取合约状态等
			const provider = new ethers.providers.JsonRpcProvider(
				infura_connection_base
			);

			// 获取 pair 合约实例
			const pairContract = new ethers.Contract(pairAddress, pair_abi, provider);
			// 获取储备量
			const reserves = await pairContract["getReserves"]();
			const [reserve0, reserve1] = reserves;

			const tokens = [tokenOneInstance, tokenTwoInstance];
			const [token0, token1] = tokens[0].sortsBefore(tokens[1])
				? tokens
				: [tokens[1], tokens[0]];

			// 是的,这里创建了一个交易对(Pair)实例
			// 使用 token0 和 token1 的储备量(reserve0, reserve1)来初始化
			// CurrencyAmount.fromRawAmount 用于将原始数量转换为带精度的货币数量
			const pair = new Pair(
				CurrencyAmount.fromRawAmount(token0, reserve0),
				CurrencyAmount.fromRawAmount(token1, reserve1)
			);
			return pair;
		} catch (error) {
			messageApi.error("流动性池不存在或查询失败");
			console.error("🚀 ~ createPair ~ error:", error);
		}
	}

	// 【2.价格计算阶段】计算价格
	async function fetchPrices(tokenOne, tokenTwo) {
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

		// 1. 创建交易对实例
		// 通过createPair获取包含两个代币储备量信息的Pair对象
		const pair = await createPair(tokenOneInstance, tokenTwoInstance);

		// 2. 创建路由实例
		// Route在Uniswap中扮演着重要角色:
		// - 它定义了代币兑换的具体路径,可以是直接兑换(A->B)或多跳兑换(A->C->B)
		// - 通过路由可以找到最优的兑换路径,获得最好的兑换价格
		// - 路由对象封装了计算价格、处理滑点等复杂逻辑
		// Route的设计原因:
		// - 分离关注点:路由负责路径和价格计算,Pair负责管理流动性
		// - 灵活性:支持未来扩展到更复杂的多跳路由
		// - 可重用:路由逻辑可以被其他功能复用,如价格预言机
		const route = new Route([pair], tokenOneInstance, tokenTwoInstance);

		// 保存实例以供后续使用
		setCurrentTokenOneInstance(tokenOneInstance);
		setCurrentTokenTwoInstance(tokenTwoInstance);
		setCurrentRoute(route);

		// 3. 计算价格
		const tokenOnePrice = route.midPrice.toSignificant(6);  // 使用route计算正向价格
		const tokenTwoPrice = route.midPrice.invert().toSignificant(6); // 使用route计算反向价格

		const ratio = tokenOnePrice;
		console.log(`计算价格 ${tokenOne.ticker}: %s, ${tokenTwo.ticker}: %s, Ratio: %s`, tokenOnePrice, tokenTwoPrice, ratio);

		setPrices({
			tokenOne: tokenOnePrice,
			tokenTwo: tokenTwoPrice,
			ratio: ratio,
		});
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
        messageApi.warning(`大额交易警告：此笔交易将导致 ${priceImpact}% 的价格影响`);
    }

		return priceImpact;
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
	async function approveToken(tokenAddress, amount) {
		console.log(
			"approve token called, token: " + tokenAddress + " with amount: " + amount
		);

		// 根据网络动态获取路由地址
		const routerAddress = getRouterAddress();
		console.log("动态获取 approve token 地址: " + routerAddress);
    if (!routerAddress || !validateRouterAddress(routerAddress)) return;

		// 获取代币的 ABI，只包含 approve 函数的最小 ABI
		// 减少不必要的合约接口定义，优化代码体积
		const tokenABI = [
			{
				inputs: [
					{ internalType: "address", name: "spender", type: "address" },
					{ internalType: "uint256", name: "value", type: "uint256" },
				],
				name: "approve",
				outputs: [{ internalType: "bool", name: "", type: "bool" }],
				stateMutability: "nonpayable",
				type: "function",
			},
		];
		// 调用 writeContract 函数，执行代币授权
		writeContract(
			{
				address: tokenAddress, // 要授权的代币地址
				abi: tokenABI, // 合约接口
				functionName: "approve", // 调用的函数
				args: [
					routerAddress,
					amount // 授权的代币数量
				]
			},
			{
				onSuccess: (tx) => {
					messageApi.info("Transaction is successful!" + tx.hash);
					setTxDetails({
						to: tx.to,
						data: tx.data,
						value: tx.value,
					});
				},
				onError: (error) => {
					console.log("🚀 ~ fetchDexSwap ~ error:", error.message);
					messageApi.error(error.shortMessage);
				},
			}
		);
	}

	// 【3.交易准备阶段】准备交易
	async function fetchDexSwap() {
		try {
			const amountIn = formatTokenAmount(tokenOneAmount, tokenOne.decimals);

			const trade = new Trade(
				currentRoute,
				CurrencyAmount.fromRawAmount(currentTokenOneInstance, amountIn),
				TradeType.EXACT_INPUT
			);

			// 计算价格影响
			const priceImpact = calculatePriceImpact(trade);
			console.log("最终价格影响: " + priceImpact);

			// 检查余额是否足够
			console.log("compare balance: " + balance);
			console.log("compare amountIn: " + amountIn);
			// eslint-disable-next-line no-undef
			// if (balance < (BigInt(amountIn) || 0n)) {
			// 	messageApi.error("余额不足");
			// 	return;
			// }

			// 计算最小获得量(考虑滑点)
			const tokenTwoOut = (
				(Number(tokenTwoAmount) * (100 - slippage)) /
				100
			).toString();
			// 将最小获得量转换为带精度的货币数量
			const amountOutMin = formatTokenAmount(tokenTwoOut, tokenTwo.decimals);

			// 准备交易参数
			const path = [currentTokenOneInstance.address, currentTokenTwoInstance.address]; // 交易路径
			const to = account.address; // 接收地址
			const deadline = Math.floor(Date.now() / 1000) + 60 * 20; // 20分钟过期时间

			console.log(amountIn, amountOutMin, path, to, deadline);

			// 授权代币，确保有足够的代币用于交易
			await approveToken(tokenOne.address, amountIn);

			const routerAddress = getRouterAddress();
			// 【交易执行阶段】发送交易
			writeContract(
				{
					address: routerAddress(),
					abi: router_abi,
					functionName: "swapExactTokensForTokens",
					args: [amountIn, amountOutMin, path, to, deadline],
				},
				{
					onSuccess: (tx) => {
						messageApi.info("Transaction is successful!" + tx.hash);
						setTxDetails({
							to: tx.to,
							data: tx.data,
							value: tx.value,
						});
					},
					onError: (error) => {
						console.log("🚀 ~ fetchDexSwap ~ error:", error.message);
						messageApi.error(error.shortMessage);
					},
				}
			);
		} catch (error) {
			messageApi.error("检查余额失败");
			console.error(error);
		}
	}

	useEffect(() => {
		// 如果没有链接钱包，则不进行价格计算
		if (!account.isConnected) {
			console.log("没有链接钱包");
			return;
		};
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
		</>
	);
}

export default Swap;
