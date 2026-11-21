import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

/** Embed public project code so the user does not need a separate download or file transfer. */
export function createServerInstallCommand(automatic) {
  const names = ['relay/self-hosted-bootstrap-cli.mjs', 'relay/self-hosted-bootstrap-service.mjs',
    'relay/self-hosted-bootstrap.mjs', 'relay/install.mjs', 'relay/provision.mjs', 'relay/unix-provision.mjs',
    'relay/server.mjs', 'relay/self-hosted-runtime.py', 'distribution/hosted-enrollment.mjs', 'secure-link/config.mjs'];
  const files = Object.fromEntries(names.map(name => [name, readFileSync(new URL('../' + name, import.meta.url)).toString('base64')]));
  const payload = gzipSync(Buffer.from(JSON.stringify(files))).toString('base64');
  const autoData = automatic ? Buffer.from(JSON.stringify(automatic)).toString('base64') : '';
  const setup = automatic
    ? `settings=json.loads(base64.b64decode("${autoData}"))\nif int(time.time()*1000)>=settings["expiresAt"]:\n print("安装命令已过期，请回电脑重新生成。",file=sys.stderr);sys.exit(1)\n`
    : `address=input("请输入服务器公网 IPv4：").strip()\ntry:\n ip=ipaddress.IPv4Address(address)\n if ip.is_loopback or ip.is_unspecified: raise ValueError()\nexcept ValueError:\n print("公网 IPv4 格式不正确，请重新运行命令。",file=sys.stderr);sys.exit(1)\n`;
  const invoke = automatic
    ? 'result=subprocess.run([node,os.path.join(root,"relay/self-hosted-bootstrap-cli.mjs"),"--automatic"],input=json.dumps(settings),text=True)'
    : 'result=subprocess.run([node,os.path.join(root,"relay/self-hosted-bootstrap-cli.mjs"),"--ip",address])';
  const program = `import base64,gzip,importlib.util,ipaddress,json,os,shutil,subprocess,sys,tempfile,time\nif not shutil.which("openssl"):\n print("请先安装 OpenSSL。",file=sys.stderr);sys.exit(1)\n${setup}files=json.loads(gzip.decompress(base64.b64decode("${payload}")))\nwith tempfile.TemporaryDirectory(prefix="rayneo-bootstrap-") as root:\n for name,data in files.items():\n  path=os.path.join(root,name);os.makedirs(os.path.dirname(path),exist_ok=True)\n  with open(path,"wb") as output: output.write(base64.b64decode(data))\n spec=importlib.util.spec_from_file_location("rayneo_runtime",os.path.join(root,"relay/self-hosted-runtime.py"))\n runtime=importlib.util.module_from_spec(spec);spec.loader.exec_module(runtime)\n try:\n  node=runtime.ensure_node()\n except Exception as error:\n  print("无法准备 Node.js 运行环境："+str(error),file=sys.stderr);sys.exit(1)\n ${invoke}\n sys.exit(result.returncode)\n`;
  const encoded = gzipSync(Buffer.from(program)).toString('base64');
  const lines = encoded.match(/.{1,800}/g).map(part => `"${part}"`).join('\n');
  const python = `python3 -c 'exec(__import__("gzip").decompress(__import__("base64").b64decode(\n${lines}\n)))'`;
  return automatic ? `rnp_ready=1\nif [ "$(id -u)" -eq 0 ]; then rnp_sudo=; elif command -v sudo >/dev/null 2>&1; then rnp_sudo=sudo; else printf '%s\\n' '请使用管理员账号登录，或安装 sudo 后重试。'; rnp_ready=0; fi\nrnp_missing=\ncommand -v python3 >/dev/null 2>&1 || rnp_missing="python3"\ncommand -v openssl >/dev/null 2>&1 || rnp_missing="$rnp_missing openssl"\nif [ "$rnp_ready" = 1 ] && [ -n "$rnp_missing" ]; then\n if command -v apt-get >/dev/null 2>&1; then\n  printf '%s\\n' '正在准备服务器所需组件…'\n  $rnp_sudo apt-get update && $rnp_sudo apt-get install -y $rnp_missing || rnp_ready=0\n else printf '%s\\n' '请先安装 Python 3 和 OpenSSL，再重试。'; rnp_ready=0; fi\nfi\nif [ "$rnp_ready" = 1 ]; then\n$rnp_sudo python3 - <<'RNP_AUTO'\nexec(__import__("gzip").decompress(__import__("base64").b64decode(\n${lines}\n)))\nRNP_AUTO\nelse printf '%s\\n' '服务器环境准备未完成，请检查上面的提示。'; fi` : `sudo ${python}`;
}
