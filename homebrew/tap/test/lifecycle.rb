# Native, network-free lifecycle fixture. Run with `brew ruby test/lifecycle.rb`.
# This exercises Homebrew mechanics, not the real runtime; the workflow also
# installs and tests the approved public formula separately.
require "digest"
require "fileutils"
require "json"
require "open3"
require "tmpdir"

FORMULA = "diffex-fixture/tap/diffex".freeze

def run(*command)
  output, status = Open3.capture2e(*command)
  raise "#{command.join(" ")} failed:\n#{output}" unless status.success?

  output
end

def check(value, message)
  raise message unless value
end

Dir.mktmpdir("diffex-brew-lifecycle-") do |temporary|
  repository = run("brew", "--repository").strip
  tap = File.join(repository, "Library/Taps/diffex-fixture/homebrew-tap")
  check(!File.exist?(tap), "Refusing to overwrite an existing fixture tap")
  source = File.read(File.expand_path("../Formula/diffex.rb", __dir__))
  FileUtils.mkdir_p(File.join(tap, "Formula"))
  run("git", "-C", tap, "init", "-q")
  retained = File.join(temporary, "user-data/retained.txt")
  FileUtils.mkdir_p(File.dirname(retained))
  File.write(retained, "retain user data\n")
  ENV["DIFFEX_CODING_AGENT_DIR"] = File.dirname(retained)
  ENV["DIFFEX_OFFLINE"] = "1"
  installed = false
  begin
    ["0.0.1", "0.0.2"].each_with_index do |version, index|
      stage = File.join(temporary, version)
      payload = File.join(stage, "diffex")
      FileUtils.mkdir_p(File.join(payload, "bin"))
      FileUtils.mkdir_p(File.join(payload, "runtime/bin"))
      File.write(File.join(payload, "bin/diffex"), <<~SH)
        #!/bin/sh
        case "$*" in
          --version) printf '%s\\n' '#{version}' ;;
          --help) printf '%s\\n' 'Diffex fixture' ;;
          --list-models) printf '%s\\n' 'fixture offline model' ;;
          'update --self') printf '%s\\n' 'brew upgrade diffexai/tap/diffex' ;;
          *) exit 1 ;;
        esac
      SH
      FileUtils.chmod(0755, File.join(payload, "bin/diffex"))
      File.write(File.join(payload, "runtime/bin/node"), "fixture bundled runtime\n")
      File.write(File.join(payload, ".retained-payload"), "fixture hidden file\n")
      File.write(File.join(payload, "LICENSE"), "fixture license\n")
      archive = File.join(temporary, "fixture-#{version}.tar.gz")
      run("tar", "-czf", archive, "-C", stage, "diffex")
      digest = Digest::SHA256.file(archive).hexdigest
      formula = source.gsub(/^  version ".*"$/, "  version \"#{version}\"")
                      .gsub(/^      url ".*"$/, "      url \"file://#{archive}\"")
                      .gsub(/^      sha256 ".*"$/, "      sha256 \"#{digest}\"")
      File.write(File.join(tap, "Formula/diffex.rb"), formula)
      run("brew", index.zero? ? "install" : "upgrade", "--formula", FORMULA)
      installed = true
      prefix = run("brew", "--prefix", FORMULA).strip
      check(run(File.join(prefix, "bin/diffex"), "--version").strip == version, "Wrong installed fixture version")
      check(File.symlink?(File.join(prefix, "bin/diffex")), "CLI must be a symlink")
      check(Dir.children(File.join(prefix, "bin")) == ["diffex"], "Only diffex may be exposed")
      marker = JSON.parse(File.read(File.join(prefix, "libexec/.diffex-homebrew.json")))
      check(marker == { "schemaVersion" => 1, "package" => "@diffexai/diffex", "formula" => "diffexai/tap/diffex" }, "Wrong ownership marker")
      check(!File.exist?(File.join(prefix, "libexec/diffex/.diffex-homebrew.json")), "Ownership marker must remain outside payload")
      Dir.glob(File.join(payload, "**/*"), File::FNM_DOTMATCH).select { |path| File.file?(path) }.each do |path|
        target = path.sub(payload, File.join(prefix, "libexec/diffex"))
        check(File.binread(target) == File.binread(path), "Payload bytes changed: #{path}")
        check(File.stat(target).mode == File.stat(path).mode, "Payload mode changed: #{path}")
      end
      run("brew", "test", FORMULA)
      check(File.read(retained) == "retain user data\n", "User data changed")
    end
    run("brew", "uninstall", "--formula", FORMULA)
    installed = false
    check(!File.exist?(File.join(run("brew", "--prefix").strip, "bin/diffex")), "CLI symlink survived uninstall")
    check(File.read(retained) == "retain user data\n", "Uninstall removed user data")
  ensure
    run("brew", "uninstall", "--formula", FORMULA) if installed
    FileUtils.rm_rf(tap)
  end
end
