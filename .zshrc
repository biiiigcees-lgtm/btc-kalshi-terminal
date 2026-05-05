export ZSH_THEME="robbyrussell"
plugins=(git)
if [ -n "$ZSH" ] && [ -f "$ZSH/oh-my-zsh.sh" ]; then
	source "$ZSH/oh-my-zsh.sh"
fi
