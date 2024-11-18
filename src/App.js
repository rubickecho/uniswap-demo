import "./App.css";
import Header from "./components/Header";
import Swap from "./components/Swap";
import SwapV3 from "./components/SwapV3";
// import Tokens from "./components/Tokens";
import { Routes, Route } from "react-router-dom";
function App() {
  return (
    <div className="App">
      <Header />
      <div className="mainWindow">
        <Routes>
          <Route path="/" element={<Swap/>} />
          <Route path="/swapV3" element={<SwapV3/>} />
          {/* <Route path="/tokens" element={<Tokens />} /> */}
        </Routes>
      </div>

    </div>
  )
}

export default App;
