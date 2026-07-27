class ChatgptCode < Formula
  desc "Private local MCP coding and computer-use harness for ChatGPT"
  homepage "https://github.com/YOUR_ORG/chatgpt-code"
  url "https://registry.npmjs.org/chatgpt-code/-/chatgpt-code-0.1.0.tgz"
  sha256 "eec4b9398ea9f210e57848934f98d9c2957c7da1d05ab48f04a5039a4dddc716"
  license "MIT"

  depends_on "node@22"
  depends_on "cloudflared"

  def install
    system Formula["node@22"].opt_bin/"npm", "install", *std_npm_args
    bin.install_symlink libexec/"bin/chatgpt-code"
  end

  test do
    assert_match "private local MCP", shell_output("#{bin}/chatgpt-code --help")
  end
end
