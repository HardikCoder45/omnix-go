class OmnixGo < Formula
  desc "Private local MCP coding and computer-use harness"
  homepage "https://github.com/HardikCoder45/omnix-go"
  url "https://registry.npmjs.org/omnix-go/-/omnix-go-0.3.3.tgz"
  sha256 "56c94ddae9ba9b212f34978f966b28abdcdbd9add325b91f7849b2839e04de08"
  license "MIT"

  depends_on "node@24"

  def install
    system Formula["node@24"].opt_bin/"npm", "install", *std_npm_args
    bin.install_symlink libexec/"bin/omnix-go"
  end

  def post_install
    system bin/"omnix-go", "service", "install", "--tunnel", "auto", "--no-open"
  end

  test do
    assert_match "private local MCP", shell_output("#{bin}/omnix-go --help")
  end
end
