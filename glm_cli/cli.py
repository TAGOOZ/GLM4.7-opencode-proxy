"""CLI interface for GLM4.7 API"""

import base64
import json
import os
import sys
import time
from pathlib import Path
from typing import Optional

import click
from rich.console import Console
from rich.panel import Panel
from rich.markdown import Markdown
from rich.live import Live
from rich.text import Text
from rich.table import Table

from .api_client import GLMClient


# Config file location
CONFIG_DIR = Path.home() / ".config" / "glm-cli"
CONFIG_FILE = CONFIG_DIR / "config.json"

console = Console()


def load_config() -> dict:
    """Load configuration from file"""
    if CONFIG_FILE.exists():
        with open(CONFIG_FILE) as f:
            return json.load(f)
    return {}


def save_config(config: dict):
    """Save configuration to file"""
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    with open(CONFIG_FILE, 'w') as f:
        json.dump(config, f, indent=2)


def _load_dotenv() -> None:
    try:
        from dotenv import load_dotenv
    except Exception:
        return
    load_dotenv()
    load_dotenv(str(CONFIG_DIR.parent / ".env"))


def _decode_jwt_payload(token: str) -> Optional[dict]:
    try:
        payload_part = token.split(".")[1]
        payload_part += "=" * (4 - len(payload_part) % 4)
        return json.loads(base64.urlsafe_b64decode(payload_part))
    except Exception:
        return None


def _save_env_token(token: str) -> None:
    env_path = CONFIG_DIR.parent / ".env"
    lines: list[str] = []
    if env_path.exists():
        try:
            lines = env_path.read_text(encoding="utf-8").splitlines()
        except Exception:
            lines = []
    updated = False
    new_lines: list[str] = []
    for line in lines:
        if line.strip().startswith("GLM_TOKEN="):
            new_lines.append(f"GLM_TOKEN={token}")
            updated = True
        else:
            new_lines.append(line)
    if not updated:
        new_lines.append(f"GLM_TOKEN={token}")
    env_path.write_text("\n".join(new_lines) + "\n", encoding="utf-8")


def _extract_token_from_context(context) -> Optional[str]:
    try:
        for cookie in context.cookies():
            if cookie.get("name") == "token" and cookie.get("value"):
                return cookie["value"]
    except Exception:
        pass
    return None


def _extract_token_from_page(page) -> Optional[str]:
    try:
        token = page.evaluate(
            "() => window.localStorage.getItem('token') || window.localStorage.getItem('access_token') || ''"
        )
        if token:
            return token
    except Exception:
        pass
    return None


def get_client() -> GLMClient:
    """Get authenticated client"""
    _load_dotenv()
    env_token = os.getenv("GLM_TOKEN")
    if env_token:
        return GLMClient(env_token)
    config = load_config()
    token = config.get("token")
    if not token:
        console.print("[red]Error:[/red] No token configured. Set GLM_TOKEN or run 'glm config --token YOUR_TOKEN' first.")
        sys.exit(1)
    return GLMClient(token)


@click.group()
@click.version_option(version="0.1.0", prog_name="glm-cli")
def cli():
    """GLM4.7 CLI - Command line interface for chat.z.ai"""
    pass


@cli.command()
@click.option("--token", "-t", required=True, help="Authentication token from chat.z.ai")
def config(token: str):
    """Configure authentication token"""
    cfg = load_config()
    cfg["token"] = token
    save_config(cfg)
    console.print("[green]✓[/green] Token saved successfully!")
    
    # Verify token works
    try:
        client = GLMClient(token)
        settings = client.get_user_settings()
        console.print(f"[green]✓[/green] Authenticated successfully!")
    except Exception as e:
        console.print(f"[yellow]Warning:[/yellow] Could not verify token: {e}")


@cli.command()
@click.option("--page", "-p", default=1, help="Page number for pagination")
def chats(page: int):
    """List all chats"""
    client = get_client()
    
    try:
        chat_list = client.list_chats(page=page)
        
        if not chat_list:
            console.print("[yellow]No chats found.[/yellow]")
            return
        
        table = Table(title="Your Chats", show_header=True)
        table.add_column("ID", style="cyan", no_wrap=True)
        table.add_column("Title", style="white")
        table.add_column("Model", style="green")
        
        for chat in chat_list:
            model = chat.models[0] if chat.models else "unknown"
            # Truncate ID for display
            short_id = chat.id[:8] + "..." if len(chat.id) > 11 else chat.id
            table.add_row(short_id, chat.title[:50], model)
        
        console.print(table)
        console.print(f"\n[dim]Page {page} - Use --page N for more[/dim]")
        
    except Exception as e:
        console.print(f"[red]Error:[/red] {e}")
        sys.exit(1)


@cli.command()
@click.option("--title", "-t", default="New Chat", help="Chat title")
@click.option("--model", "-m", default="glm-4.7", help="Model to use")
def new(title: str, model: str):
    """Create a new chat"""
    client = get_client()
    
    try:
        chat = client.create_chat(title=title, model=model)
        console.print(f"[green]✓[/green] Chat created!")
        console.print(f"  ID: [cyan]{chat.id}[/cyan]")
        console.print(f"  Title: {chat.title}")
        console.print(f"\nUse: [dim]glm chat {chat.id} \"Your message\"[/dim]")
    except Exception as e:
        console.print(f"[red]Error:[/red] {e}")
        sys.exit(1)


@cli.command()
@click.option("--headless", is_flag=True, help="Run browser headless (not recommended for OAuth login)")
@click.option("--timeout", default=300, show_default=True, help="Seconds to wait for login")
@click.option("--check", is_flag=True, help="Validate saved token and exit")
def login(headless: bool, timeout: int, check: bool):
    """Log in via browser (Google OAuth) and save the token"""
    if check:
        try:
            client = get_client()
            client.get_user_settings()
            console.print("[green]✓[/green] Token is valid.")
        except Exception as e:
            console.print(f"[red]Error:[/red] Token invalid or expired: {e}")
            sys.exit(1)
        return
    try:
        from playwright.sync_api import sync_playwright
    except Exception:
        console.print("[red]Error:[/red] Playwright is not installed. Run: pip install -r requirements.txt")
        console.print("Then run: playwright install")
        sys.exit(1)

    console.print(
        "[bold]Login flow:[/bold]\n"
        "1) A browser window will open at chat.z.ai\n"
        "2) Sign in with Google\n"
        "3) Return here and wait; token will be captured automatically"
    )

    token: Optional[str] = None
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=headless)
        context = browser.new_context()
        page = context.new_page()
        page.goto("https://chat.z.ai", wait_until="domcontentloaded")

        start = time.time()
        while time.time() - start < timeout:
            token = _extract_token_from_context(context)
            if not token:
                token = _extract_token_from_page(page)
            if token:
                break
            time.sleep(1)

        browser.close()

    if not token:
        console.print("[red]Error:[/red] Could not capture token. Try again or use 'glm config --token'.")
        sys.exit(1)

    cfg = load_config()
    cfg["token"] = token
    save_config(cfg)
    _save_env_token(token)
    console.print("[green]✓[/green] Token saved successfully!")


@cli.command()
@click.argument("chat_id")
@click.argument("message")
@click.option("--no-thinking", is_flag=True, help="Disable thinking mode")
@click.option("--signature", "-s", help="Manual X-Signature header (captured from browser)")
@click.option("--timestamp", "-t", type=int, help="Timestamp from browser request (milliseconds)")
@click.option("--request-id", "-r", help="Request ID from browser request")
def chat(chat_id: str, message: str, no_thinking: bool, signature: str, timestamp: int, request_id: str):
    """Send a message to a chat
    
    For manual signature mode, capture these from browser DevTools and provide all three:
    --signature, --timestamp, and --request-id
    """
    client = get_client()
    
    messages = [{"role": "user", "content": message}]
    
    thinking_content = []
    response_content = []
    
    # Validate manual signature params
    if signature and not (timestamp and request_id):
        console.print("[red]Error:[/red] When using --signature, you must also provide --timestamp and --request-id")
        sys.exit(1)
    
    try:
        console.print(f"[dim]Sending to chat {chat_id[:8]}...[/dim]\n")
        
        with Live(console=console, refresh_per_second=10) as live:
            current_text = Text()
            in_thinking = False
            
            for chunk in client.send_message(
                chat_id=chat_id,
                messages=messages,
                enable_thinking=not no_thinking,
                manual_signature=signature,
                manual_timestamp=timestamp,
                manual_request_id=request_id
            ):
                if chunk["type"] == "thinking":
                    if not in_thinking:
                        in_thinking = True
                        current_text.append("🤔 Thinking...\n", style="dim italic")
                    thinking_content.append(chunk["data"])
                    current_text.append(chunk["data"], style="dim")
                    
                elif chunk["type"] == "thinking_end":
                    in_thinking = False
                    current_text.append("\n\n", style="")
                    
                elif chunk["type"] == "content":
                    response_content.append(chunk["data"])
                    current_text.append(chunk["data"], style="bold")
                    
                elif chunk["type"] == "error":
                    current_text.append(f"\n[Error: {chunk['data']}]", style="red")
                    
                elif chunk["type"] == "done":
                    pass
                
                live.update(current_text)
        
        console.print()  # Final newline
        
    except KeyboardInterrupt:
        console.print("\n[yellow]Cancelled[/yellow]")
    except Exception as e:
        console.print(f"[red]Error:[/red] {e}")
        sys.exit(1)


@cli.command()
@click.option("--chat-id", "-c", help="Continue existing chat (optional)")
@click.option("--model", "-m", default="glm-4.7", help="Model to use")
def interactive(chat_id: Optional[str], model: str):
    """Start an interactive conversation"""
    client = get_client()
    
    # Create new chat if not provided
    if not chat_id:
        try:
            chat = client.create_chat(title="Interactive CLI Session", model=model)
            chat_id = chat.id
            console.print(f"[green]✓[/green] Created new chat: [cyan]{chat_id[:8]}...[/cyan]\n")
        except Exception as e:
            console.print(f"[red]Error creating chat:[/red] {e}")
            sys.exit(1)
    
    console.print(Panel.fit(
        "[bold]GLM4.7 Interactive Mode[/bold]\n"
        "Type your message and press Enter to send.\n"
        "Commands: [dim]/quit[/dim] to exit, [dim]/clear[/dim] to reset",
        border_style="blue"
    ))
    
    conversation = []
    
    while True:
        try:
            # Get user input
            console.print()
            user_input = console.input("[bold green]You:[/bold green] ")
            
            if not user_input.strip():
                continue
            
            # Handle commands
            if user_input.strip().lower() == "/quit":
                console.print("[dim]Goodbye![/dim]")
                break
            
            if user_input.strip().lower() == "/clear":
                conversation = []
                console.print("[dim]Conversation cleared.[/dim]")
                continue
            
            # Add user message to conversation
            conversation.append({"role": "user", "content": user_input})
            
            # Stream response
            console.print()
            console.print("[bold blue]GLM:[/bold blue] ", end="")
            
            response_text = []
            
            for chunk in client.send_message(
                chat_id=chat_id,
                messages=conversation,
                model=model,
                include_history=False
            ):
                if chunk["type"] == "thinking":
                    # Show thinking indicator once
                    pass
                elif chunk["type"] == "content":
                    response_text.append(chunk["data"])
                    console.print(chunk["data"], end="")
                elif chunk["type"] == "error":
                    console.print(f"\n[red]Error: {chunk['data']}[/red]")
                    break
            
            console.print()  # Newline after response
            
            # Add assistant response to conversation
            if response_text:
                conversation.append({
                    "role": "assistant",
                    "content": "".join(response_text)
                })
            
        except KeyboardInterrupt:
            console.print("\n[dim]Use /quit to exit[/dim]")
        except EOFError:
            console.print("\n[dim]Goodbye![/dim]")
            break


@cli.command()
def whoami():
    """Show current user info"""
    client = get_client()
    
    try:
        settings = client.get_user_settings()
        if not settings:
            payload = _decode_jwt_payload(client.token)
            data = payload if payload else {"error": "No settings returned and token decode failed."}
            console.print(Panel.fit(
                f"[bold]User Settings[/bold]\n\n{json.dumps(data, indent=2)}",
                border_style="green"
            ))
            return
        console.print(Panel.fit(
            f"[bold]User Settings[/bold]\n\n{json.dumps(settings, indent=2)}",
            border_style="green"
        ))
    except Exception as e:
        console.print(f"[red]Error:[/red] {e}")
        sys.exit(1)


def main():
    """Entry point"""
    cli()


if __name__ == "__main__":
    main()
