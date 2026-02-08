// Game canvas setup
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');

// Set canvas size
canvas.width = 800;
canvas.height = 300;

// Game variables
let gameRunning = true;
let score = 0;
let animationId;
let gameSpeed = 5;

// Dinosaur object
const dino = {
    x: 50,
    y: 200,
    width: 50,
    height: 60,
    velocityY: 0,
    gravity: 0.8,
    jumpStrength: -15,
    isJumping: false,
    groundY: 200,
    
    draw() {
        // Draw dinosaur body
        ctx.fillStyle = '#535353';
        ctx.fillRect(this.x, this.y, this.width, this.height);
        
        // Draw dinosaur head
        ctx.fillRect(this.x + 30, this.y - 20, 30, 25);
        
        // Draw eye
        ctx.fillStyle = '#fff';
        ctx.fillRect(this.x + 50, this.y - 15, 8, 8);
        
        // Draw legs
        ctx.fillStyle = '#535353';
        if (!this.isJumping) {
            // Animated legs
            if (Math.floor(score / 10) % 2 === 0) {
                ctx.fillRect(this.x + 10, this.y + this.height, 10, 15);
                ctx.fillRect(this.x + 30, this.y + this.height, 10, 10);
            } else {
                ctx.fillRect(this.x + 10, this.y + this.height, 10, 10);
                ctx.fillRect(this.x + 30, this.y + this.height, 10, 15);
            }
        } else {
            ctx.fillRect(this.x + 10, this.y + this.height, 10, 12);
            ctx.fillRect(this.x + 30, this.y + this.height, 10, 12);
        }
    },
    
    jump() {
        if (!this.isJumping) {
            this.velocityY = this.jumpStrength;
            this.isJumping = true;
        }
    },
    
    update() {
        this.velocityY += this.gravity;
        this.y += this.velocityY;
        
        if (this.y >= this.groundY) {
            this.y = this.groundY;
            this.velocityY = 0;
            this.isJumping = false;
        }
    }
};

// Obstacles array
let obstacles = [];

// Create obstacle
function createObstacle() {
    const types = ['small', 'medium', 'large', 'double'];
    const type = types[Math.floor(Math.random() * types.length)];
    
    let obstacle = {
        x: canvas.width,
        y: 220,
        width: 30,
        height: 40,
        type: type
    };
    
    switch(type) {
        case 'small':
            obstacle.width = 20;
            obstacle.height = 30;
            break;
        case 'medium':
            obstacle.width = 30;
            obstacle.height = 40;
            break;
        case 'large':
            obstacle.width = 40;
            obstacle.height = 50;
            break;
        case 'double':
            obstacle.width = 60;
            obstacle.height = 35;
            break;
    }
    
    obstacle.y = 240 - obstacle.height;
    obstacles.push(obstacle);
}

// Draw obstacle
function drawObstacle(obstacle) {
    ctx.fillStyle = '#535353';
    
    if (obstacle.type === 'double') {
        // Double cactus
        ctx.fillRect(obstacle.x, obstacle.y, 25, obstacle.height);
        ctx.fillRect(obstacle.x + 35, obstacle.y + 10, 25, obstacle.height - 10);
    } else {
        // Single cactus
        ctx.fillRect(obstacle.x, obstacle.y, obstacle.width, obstacle.height);
        // Add some detail to cactus
        ctx.fillRect(obstacle.x - 5, obstacle.y + 10, 8, 15);
        ctx.fillRect(obstacle.x + obstacle.width - 3, obstacle.y + 15, 8, 12);
    }
}

// Update obstacles
function updateObstacles() {
    for (let i = 0; i < obstacles.length; i++) {
        obstacles[i].x -= gameSpeed;
        
        // Remove off-screen obstacles
        if (obstacles[i].x + obstacles[i].width < 0) {
            obstacles.splice(i, 1);
            i--;
        }
    }
    
    // Add new obstacles
    if (obstacles.length === 0 || obstacles[obstacles.length - 1].x < canvas.width - 300) {
        if (Math.random() < 0.02) {
            createObstacle();
        }
    }
}

// Check collision
function checkCollision() {
    for (let obstacle of obstacles) {
        // Simple box collision with some padding
        const padding = 5;
        if (
            dino.x + padding < obstacle.x + obstacle.width - padding &&
            dino.x + dino.width - padding > obstacle.x + padding &&
            dino.y + padding < obstacle.y + obstacle.height - padding &&
            dino.y + dino.height - padding > obstacle.y + padding
        ) {
            return true;
        }
    }
    return false;
}

// Draw ground
function drawGround() {
    ctx.fillStyle = '#535353';
    ctx.fillRect(0, 240, canvas.width, 2);
}

// Draw clouds
let clouds = [
    { x: 100, y: 50, width: 60, height: 20 },
    { x: 300, y: 80, width: 80, height: 25 },
    { x: 500, y: 40, width: 70, height: 22 }
];

function drawClouds() {
    ctx.fillStyle = '#d4d4d4';
    clouds.forEach(cloud => {
        ctx.beginPath();
        ctx.arc(cloud.x, cloud.y, 15, 0, Math.PI * 2);
        ctx.arc(cloud.x + 20, cloud.y - 5, 20, 0, Math.PI * 2);
        ctx.arc(cloud.x + 40, cloud.y, 15, 0, Math.PI * 2);
        ctx.fill();
        
        cloud.x -= 1;
        if (cloud.x + cloud.width < 0) {
            cloud.x = canvas.width + Math.random() * 100;
        }
    });
}

// Update score
function updateScore() {
    score++;
    document.getElementById('score').textContent = Math.floor(score / 10);
    
    // Increase game speed gradually
    if (score % 500 === 0) {
        gameSpeed += 0.5;
    }
}

// Game over
function gameOver() {
    gameRunning = false;
    cancelAnimationFrame(animationId);
    document.getElementById('gameOver').style.display = 'block';
}

// Reset game
function resetGame() {
    dino.y = dino.groundY;
    dino.velocityY = 0;
    dino.isJumping = false;
    obstacles = [];
    score = 0;
    gameSpeed = 5;
    gameRunning = true;
    document.getElementById('gameOver').style.display = 'none';
    document.getElementById('score').textContent = '0';
    gameLoop();
}

// Main game loop
function gameLoop() {
    // Clear canvas
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    // Draw background
    ctx.fillStyle = '#f7f7f7';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    // Draw clouds
    drawClouds();
    
    // Draw ground
    drawGround();
    
    // Update and draw dinosaur
    dino.update();
    dino.draw();
    
    // Update and draw obstacles
    updateObstacles();
    obstacles.forEach(drawObstacle);
    
    // Check collision
    if (checkCollision()) {
        gameOver();
        return;
    }
    
    // Update score
    updateScore();
    
    // Continue game loop
    if (gameRunning) {
        animationId = requestAnimationFrame(gameLoop);
    }
}

// Event listeners
document.addEventListener('keydown', (e) => {
    if (e.code === 'Space') {
        e.preventDefault();
        if (gameRunning) {
            dino.jump();
        } else {
            resetGame();
        }
    }
});

canvas.addEventListener('click', () => {
    if (gameRunning) {
        dino.jump();
    } else {
        resetGame();
    }
});

canvas.addEventListener('touchstart', (e) => {
    e.preventDefault();
    if (gameRunning) {
        dino.jump();
    } else {
        resetGame();
    }
});

// Start game
gameLoop();