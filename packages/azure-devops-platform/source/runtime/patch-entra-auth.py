"""修正固定版 SDK 將 Entra guest 強制解讀為原始 MSA 的相容性問題。"""
from pathlib import Path
import sys

root = Path("/opt/agent-system/azure-cli/extensions/azure-devops")
client = root / "azext_devops/devops_sdk/client.py"
source = client.read_text(encoding="utf-8")
old = "self._force_msa_pass_through = True"
new = "self._force_msa_pass_through = False"
if source.count(old) == 1:
    client.write_text(source.replace(old, new), encoding="utf-8")
elif source.count(new) != 1:
    raise RuntimeError("Azure DevOps SDK 與固定版本的修補契約不符")

# 載入實際 SDK，確認修補結果而不發送網路請求。
sys.path.insert(0, str(root))
from azext_devops.devops_sdk.client import Client
from msrest.authentication import BasicAuthentication

assert Client("https://dev.azure.com/fixture", BasicAuthentication("", "fixture"))._force_msa_pass_through is False
print("Azure DevOps SDK Entra guest identity: OK")
